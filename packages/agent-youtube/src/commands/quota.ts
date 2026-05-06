/**
 * quota command - check remaining quota
 */

import { getQuotaStatus } from "../state/quota.js";

interface QuotaOptions {
  json?: boolean;
}

export async function quotaCommand(options: QuotaOptions): Promise<void> {
  const status = await getQuotaStatus();

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    const usedPct = Math.round((status.used / status.limit) * 100);
    console.log(`Quota for ${status.date}:`);
    console.log(`  Used: ${status.used.toLocaleString()} / ${status.limit.toLocaleString()} (${usedPct}%)`);
    console.log(`  Remaining: ${status.remaining.toLocaleString()}`);
    console.log(`  Uploads remaining: ${status.uploadsRemaining}`);
    console.log(`  Resets at: ${status.resetsAt}`);
  }
}
