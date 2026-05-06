import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

// Set to the auth user UUID you want to verify against (e.g. via `TEST_AUTH_USER_ID=... node verify-migration.mjs`).
const TEST_AUTH_USER_ID = process.env.TEST_AUTH_USER_ID;
if (!TEST_AUTH_USER_ID) {
  console.error('TEST_AUTH_USER_ID env var is required');
  process.exit(1);
}

async function verify() {
  const client = new Client({ connectionString: process.env.SKILL_NETWORKS_DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  const results = {};
  let allPassed = true;

  // 1. auth_user_id column exists on resources table
  console.log('--- Check 1: auth_user_id column exists ---');
  const col = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resources' AND column_name='auth_user_id'`
  );
  results.auth_user_id_column = col.rows.length === 1;
  console.log(`  rows: ${col.rows.length}, passed: ${results.auth_user_id_column}`);
  if (!results.auth_user_id_column) allPassed = false;

  // 2. provision_user function exists with prosecdef=true
  console.log('--- Check 2: provision_user function exists (SECURITY DEFINER) ---');
  const fn = await client.query(
    `SELECT prosecdef FROM pg_proc WHERE proname='provision_user'`
  );
  results.provision_user_function = fn.rows.length === 1 && fn.rows[0].prosecdef === true;
  console.log(`  rows: ${fn.rows.length}, prosecdef: ${fn.rows[0]?.prosecdef}, passed: ${results.provision_user_function}`);
  if (!results.provision_user_function) allPassed = false;

  // 3. handle_new_auth_user trigger exists
  console.log('--- Check 3: handle_new_auth_user trigger exists ---');
  const trig = await client.query(
    `SELECT tgname FROM pg_trigger WHERE tgname='handle_new_auth_user'`
  );
  results.handle_new_auth_user_trigger = trig.rows.length === 1;
  console.log(`  rows: ${trig.rows.length}, passed: ${results.handle_new_auth_user_trigger}`);
  if (!results.handle_new_auth_user_trigger) allPassed = false;

  // 4. Test user resource exists with auth_user_id set
  console.log('--- Check 4: Test user resource exists ---');
  const userRows = await client.query(
    `SELECT id, name, type, auth_user_id FROM resources WHERE auth_user_id=$1::uuid`,
    [TEST_AUTH_USER_ID]
  );
  const userResource = userRows.rows.find(r => r.type === 'user');
  results.provision_user_called = null;

  // Also look up project resource (by name pattern)
  const proj = await client.query(
    `SELECT id, name, type FROM resources WHERE name='project:' || $1`,
    [TEST_AUTH_USER_ID]
  );

  if (userResource && proj.rows.length > 0) {
    results.provision_user_called = {
      user_resource_id: userResource.id,
      project_resource_id: proj.rows[0].id
    };
    console.log(`  user_resource_id: ${userResource.id}`);
    console.log(`  project_resource_id: ${proj.rows[0].id}`);
    console.log(`  passed: true`);
  } else {
    console.log(`  FAILED: user rows=${userRows.rows.length}, project rows=${proj.rows.length}`);
    allPassed = false;
  }

  const PROJECT_ID = proj.rows[0]?.id;

  // 5. Parent links count > 200
  console.log('--- Check 5: Parent links to test project > 200 ---');
  if (PROJECT_ID) {
    const links = await client.query(
      `SELECT COUNT(*) as cnt FROM resource_links WHERE to_id=$1 AND link_type='parent'`,
      [PROJECT_ID]
    );
    const cnt = parseInt(links.rows[0].cnt, 10);
    results.parent_links_inserted = cnt;
    console.log(`  count: ${cnt}, passed: ${cnt > 200}`);
    if (cnt <= 200) allPassed = false;
  } else {
    console.log('  SKIPPED: no project ID');
    results.parent_links_inserted = 0;
    allPassed = false;
  }

  // 6. users_select_project_children policy exists
  console.log('--- Check 6: users_select_project_children policy exists ---');
  const pol = await client.query(
    `SELECT policyname FROM pg_policies WHERE policyname='users_select_project_children'`
  );
  results.rls_policy_created = pol.rows.length === 1;
  console.log(`  rows: ${pol.rows.length}, passed: ${results.rls_policy_created}`);
  if (!results.rls_policy_created) allPassed = false;

  console.log('\n--- VERIFICATION RESULTS ---');
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nAll checks passed: ${allPassed}`);

  await client.end();
  return { results, allPassed };
}

verify().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
