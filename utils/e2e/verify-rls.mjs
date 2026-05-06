import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  console.error('SUPABASE_URL not set');
  process.exit(1);
}
if (!anonKey) {
  console.error('VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) not set');
  process.exit(1);
}

const results = {};

// Test WITHOUT auth
console.log('--- Test 1: Without authentication ---');
const anonClient = createClient(supabaseUrl, anonKey);
const { data: noAuthData, error: noAuthError } = await anonClient.from('resources').select('id');
const noAuthCount = noAuthData?.length ?? 0;
console.log('Without auth, count:', noAuthCount, noAuthError ? `error: ${noAuthError.message}` : '');
results.rls_without_auth_count = noAuthCount;

if (noAuthCount === 0) {
  console.log('ASSERTION PASSED: unauthenticated users see 0 resources');
} else {
  console.log(`ASSERTION FAILED: expected 0, got ${noAuthCount}`);
}

// Test WITH a signed-in user's JWT
console.log('\n--- Test 2: With user authentication ---');
const authedClient = createClient(supabaseUrl, anonKey);
const { data: signInData, error: signInError } = await authedClient.auth.signInWithPassword({
  email: process.env.VITE_DEBUG_EMAIL,
  password: process.env.VITE_DEBUG_PASSWORD
});

if (signInError) {
  console.error('signIn failed:', signInError.message);
  process.exit(1);
}
console.log('signIn succeeded, user:', signInData.user?.email);

const { data: withAuthData, error: withAuthError } = await authedClient.from('resources').select('id');
const withAuthCount = withAuthData?.length ?? 0;
console.log('With auth, count:', withAuthCount, withAuthError ? `error: ${withAuthError.message}` : '');
results.rls_with_auth_count = withAuthCount;

if (withAuthCount > 200) {
  console.log(`ASSERTION PASSED: authenticated user sees ${withAuthCount} resources (> 200)`);
} else {
  console.log(`ASSERTION FAILED: expected > 200, got ${withAuthCount}`);
}

console.log('\n--- RLS VERIFICATION RESULTS ---');
console.log(JSON.stringify(results, null, 2));
console.log(`\nAll RLS checks passed: ${noAuthCount === 0 && withAuthCount > 200}`);
