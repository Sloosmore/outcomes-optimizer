import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationPath = path.join(__dirname, '../../drizzle/0052_provision_user.sql');
const sql = readFileSync(migrationPath, 'utf8');

// Split into statements by semicolons, preserving $$ blocks
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';

  const lines = sql.split('\n');
  for (const line of lines) {
    // Skip comment-only lines when building current
    current += line + '\n';

    // Check for dollar quoting
    const dollarMatches = line.match(/\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$/g) || [];
    for (const match of dollarMatches) {
      if (!inDollarQuote) {
        inDollarQuote = true;
        dollarTag = match;
      } else if (match === dollarTag) {
        inDollarQuote = false;
        dollarTag = '';
      }
    }

    // If we're not in a dollar-quoted block and line ends with semicolon (or has one)
    if (!inDollarQuote && line.trimEnd().endsWith(';')) {
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') {
        statements.push(trimmed);
      }
      current = '';
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

async function applyMigration() {
  const client = new Client({ connectionString: process.env.SKILL_NETWORKS_DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  const statements = splitStatements(sql);
  console.log(`Found ${statements.length} SQL statements to execute`);

  let successCount = 0;
  let skipCount = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.substring(0, 80).replace(/\n/g, ' ');

    try {
      await client.query(stmt);
      console.log(`[${i+1}/${statements.length}] OK: ${preview}...`);
      successCount++;
    } catch (e) {
      // Handle idempotency errors gracefully
      if (e.code === '42701') { // column already exists
        console.log(`[${i+1}/${statements.length}] SKIP (column exists): ${preview}...`);
        skipCount++;
      } else if (e.code === '42710') { // object already exists (policy, trigger, etc.)
        console.log(`[${i+1}/${statements.length}] SKIP (already exists): ${preview}...`);
        skipCount++;
      } else if (e.code === '42P07') { // relation already exists
        console.log(`[${i+1}/${statements.length}] SKIP (relation exists): ${preview}...`);
        skipCount++;
      } else {
        console.error(`[${i+1}/${statements.length}] FAILED: ${preview}...`);
        console.error(`  Error code: ${e.code}, Message: ${e.message}`);
        await client.end();
        process.exit(1);
      }
    }
  }

  console.log(`\nMigration complete: ${successCount} succeeded, ${skipCount} skipped`);
  await client.end();
}

applyMigration().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
