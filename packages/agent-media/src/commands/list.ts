/**
 * List adapters command
 */

import { adapterRegistry } from "../adapters/index.js";
import type { Modality } from "../config.js";

export interface ListCommandOptions {
  modality?: Modality;
  json?: boolean;
}

export function listCommand(options: ListCommandOptions): void {
  const all = adapterRegistry.all();

  let adapters = Array.from(all.entries());

  // Filter by modality if specified
  if (options.modality) {
    adapters = adapters.filter(([_, info]) =>
      info.adapter.capabilities.modalities.includes(options.modality!)
    );
  }

  if (options.json) {
    const result = adapters.map(([name, info]) => {
      const authCheck = adapterRegistry.checkAuth(name);
      return {
        name,
        description: info.description,
        modalities: info.adapter.capabilities.modalities,
        requiresAuth: info.requiresAuth,
        authEnvVars: info.authEnvVars,
        authOk: authCheck.ok,
        authMissing: authCheck.missing.length > 0 ? authCheck.missing : undefined,
      };
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (adapters.length === 0) {
    console.log(
      options.modality
        ? `No adapters found for ${options.modality}.`
        : "No adapters registered."
    );
    return;
  }

  // Group by modality for nicer display
  const byModality = new Map<Modality, string[]>();

  for (const [name, info] of adapters) {
    for (const mod of info.adapter.capabilities.modalities) {
      if (!byModality.has(mod)) {
        byModality.set(mod, []);
      }
      byModality.get(mod)!.push(name);
    }
  }

  // Show defaults
  console.log("Defaults:");
  for (const mod of ["image", "video", "audio"] as Modality[]) {
    try {
      const def = adapterRegistry.getDefault(mod);
      console.log(`  ${mod}: ${def}`);
    } catch {
      console.log(`  ${mod}: (none)`);
    }
  }
  console.log();

  // Show adapters
  console.log("Adapters:");
  for (const [name, info] of adapters) {
    const modalities = info.adapter.capabilities.modalities.join(", ");
    const authStatus = info.requiresAuth
      ? adapterRegistry.checkAuth(name).ok
        ? "(auth ok)"
        : "(needs auth)"
      : "";

    console.log(`  ${name}`);
    console.log(`    ${info.description}`);
    console.log(`    Modalities: ${modalities} ${authStatus}`);
    if (info.authEnvVars?.length) {
      console.log(`    Env vars: ${info.authEnvVars.join(", ")}`);
    }
    console.log();
  }
}
