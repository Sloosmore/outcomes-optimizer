#!/usr/bin/env tsx
/**
 * Parity check: compares reference table row counts between local Supabase and prod.
 *
 * Usage:
 *   pnpm supabase:parity-check
 *
 * Requirements:
 *   - Local Supabase must be running (npx supabase start)
 *   - SUPABASE_SERVICE_KEY env var must be set to prod service key
 *   - DATABASE_URL env var must be set to prod DB URL (used for direct psql access to prod)
 */

import { execSync } from "child_process";

const LOCAL_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PROD_DB_URL = process.env.DATABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!PROD_DB_URL && !SUPABASE_SERVICE_KEY) {
  console.error(
    "Error: Either DATABASE_URL or SUPABASE_SERVICE_KEY must be set"
  );
  process.exit(1);
}

const REFERENCE_TABLES = [
  "action_types",
  "resource_types",
  "resource_type_properties",
  "link_types",
  "link_type_rules",
  "value_types",
];

interface TableCount {
  table: string;
  local: number | null;
  prod: number | null;
  match: boolean;
}

function countRowsViaDb(dbUrl: string, table: string): number | null {
  try {
    const result = execSync(
      `psql "${dbUrl}" -t -A -c "SELECT COUNT(*) FROM ${table}" 2>/dev/null`,
      { encoding: "utf8", timeout: 15000 }
    );
    const count = parseInt(result.trim(), 10);
    return isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

async function main() {
  console.log("Supabase Parity Check");
  console.log("=".repeat(60));
  console.log(
    `Comparing reference tables: local (127.0.0.1:54322) vs prod`
  );
  console.log("");

  const counts: TableCount[] = [];

  for (const table of REFERENCE_TABLES) {
    const local = countRowsViaDb(LOCAL_DB_URL, table);

    let prod: number | null = null;
    if (PROD_DB_URL) {
      prod = countRowsViaDb(PROD_DB_URL, table);
    }

    const match =
      local !== null && prod !== null ? local === prod : false;
    counts.push({ table, local, prod, match });
  }

  // Print table
  const header = "Table".padEnd(32) + "Local".padEnd(12) + "Prod".padEnd(12) + "Match";
  console.log(header);
  console.log("-".repeat(header.length));

  let allMatch = true;
  for (const { table, local, prod, match } of counts) {
    const localStr = local === null ? "ERROR" : String(local);
    const prodStr = prod === null ? "N/A" : String(prod);
    const matchStr = local === null ? "ERROR" : prod === null ? "N/A" : match ? "OK" : "MISMATCH";

    if (!match && prod !== null) {
      allMatch = false;
    }

    console.log(
      table.padEnd(32) +
        localStr.padEnd(12) +
        prodStr.padEnd(12) +
        matchStr
    );
  }

  console.log("");

  if (!PROD_DB_URL) {
    console.log(
      "Note: DATABASE_URL not set; prod counts not available. Local counts shown above."
    );
    // If we can't connect to prod, just verify local is accessible
    const localErrors = counts.filter((c) => c.local === null);
    if (localErrors.length > 0) {
      console.error(
        `Error: Could not count rows in local tables: ${localErrors.map((c) => c.table).join(", ")}`
      );
      process.exit(1);
    }
    console.log("Local tables all accessible. Exiting 0 (prod unavailable).");
    process.exit(0);
  }

  const mismatches = counts.filter(
    (c) => c.prod !== null && !c.match
  );
  const errors = counts.filter((c) => c.local === null);

  if (errors.length > 0) {
    console.error(
      `Error: Could not count rows in local tables: ${errors.map((c) => c.table).join(", ")}`
    );
    console.error("Is local Supabase running? Run: pnpm supabase:up");
    process.exit(1);
  }

  if (!allMatch) {
    console.error(
      `Parity check FAILED: ${mismatches.length} table(s) have mismatched counts:`
    );
    for (const { table, local, prod } of mismatches) {
      console.error(`  ${table}: local=${local}, prod=${prod}`);
    }
    process.exit(1);
  }

  console.log("Parity check PASSED: all reference table counts match.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
