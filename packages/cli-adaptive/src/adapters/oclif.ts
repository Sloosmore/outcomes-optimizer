import type { Hook, Hooks } from '@oclif/core/hooks';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AliasStore } from '../alias-store.js';
import { FileTraceAdapter } from '../trace.js';
import { match } from '../matcher.js';
import { sanitizeBinName } from '../argv-utils.js';
import type { AdaptiveOptions } from '../types.js';

/**
 * Minimal interface for an oclif command descriptor.
 * oclif uses colon-separated IDs internally (e.g. 'resource:link').
 */
interface OclifCommandDescriptor {
  id: string;
}

/**
 * Minimal config interface for oclif hook context.
 * Only what we need for our hook implementation.
 */
interface OclifConfig {
  commandIDs?: string[];
  commands?: OclifCommandDescriptor[];
  bin?: string;
}

/**
 * Convert an oclif colon-separated command ID to a space-separated path.
 * e.g. 'resource:link' → 'resource link'
 */
function oclifIdToPath(id: string): string {
  return id.replace(/:/g, ' ');
}

/**
 * Convert a space-separated command path to an oclif colon-separated ID.
 * e.g. 'resource link' → 'resource:link'
 */
function pathToOclifId(path: string): string {
  return path.replace(/\s+/g, ':');
}

/**
 * Get known command paths from an oclif config object.
 * Handles both commandIDs[] and commands[] formats.
 */
function getKnownCommandPaths(config: OclifConfig): string[] {
  if (config.commandIDs && Array.isArray(config.commandIDs)) {
    return config.commandIDs.map(oclifIdToPath);
  }
  if (config.commands && Array.isArray(config.commands)) {
    return config.commands.map((c) => oclifIdToPath(c.id));
  }
  return [];
}

/**
 * Create an oclif `command_not_found` hook that provides adaptive alias support.
 *
 * Behavior:
 * - If the unknown command ID matches an alias: calls the real command
 * - If the unknown command ID has no alias: performs structural match and suggests one
 *
 * Usage in an oclif project:
 * ```ts
 * // src/hooks/command_not_found.ts
 * export { hook as default } from 'cli-adaptive/adapters/oclif'
 *
 * // Or create the hook with custom options:
 * import { withAdaptiveAliasesOclif } from 'cli-adaptive'
 * export default withAdaptiveAliasesOclif({ storagePath: '~/.mycli' })
 * ```
 */
export function withAdaptiveAliasesOclif(
  options: AdaptiveOptions = {}
): Hook<'command_not_found'> {
  // H4: Store and tracer are created lazily inside the hook so we can use config.bin
  // for per-CLI scoping when no explicit storagePath is provided.
  let store: AliasStore | null = null;
  let tracer = options.traceAdapter ?? null;

  const hook: Hook<'command_not_found'> = async function (
    this: Hook.Context,
    opts: Hooks['command_not_found']['options'] & { config: OclifConfig }
  ) {
    const { id, config } = opts;

    // H4: Lazily initialize store with bin-scoped path on first invocation
    // Sanitize bin to prevent path traversal via a crafted config.bin value
    if (store === null) {
      const bin = sanitizeBinName((config as OclifConfig).bin ?? 'default');
      const storagePath = options.storagePath ?? join(homedir(), '.cli-adaptive', bin);
      store = new AliasStore(storagePath);
      if (tracer === null) {
        tracer = new FileTraceAdapter(storagePath);
      }
    }

    // oclif uses colon-separated IDs; normalize to space-separated for matching
    const inputPath = oclifIdToPath(id);

    // Collect known commands from config
    const knownCommands = getKnownCommandPaths(config as OclifConfig);

    // H9: Track which key actually matched to record the correct hit
    let matchedKey: string | null = null;
    let aliasTarget = store.findAlias(inputPath);
    if (aliasTarget !== null) {
      matchedKey = inputPath;
    } else {
      aliasTarget = store.findAlias(id);
      if (aliasTarget !== null) {
        matchedKey = id;
      }
    }

    if (aliasTarget !== null && matchedKey !== null) {
      // Alias found — record the hit against the correct key, then run the real command
      store.recordHit(matchedKey);

      const realId = pathToOclifId(aliasTarget);
      const runnable = (config as any).runCommand;
      if (typeof runnable === 'function') {
        await runnable.call(config, realId, opts.argv ?? []);
        return;
      }

      // Alias matched but runCommand is unavailable — warn and exit so oclif's
      // default command_not_found handler does not print a second "not found" message.
      process.stderr.write(
        `Alias "${matchedKey}" resolved to "${aliasTarget}" but the command could not be executed (config.runCommand unavailable).\n`
      );
      this.exit(1);
      return;
    }

    // No alias — try structural match
    const result = match(inputPath, knownCommands);
    const suggestion = result?.command ?? null;
    const confidence = result?.confidence ?? null;

    tracer!.logAttempt({
      command: [id, ...(opts.argv ?? [])],
      suggestion,
      confidence,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });

    // Sanitize bin name before interpolating into stderr output. config.bin
    // can be set from arbitrary user/package metadata; restrict it to a safe
    // subset so we never emit shell-special characters (e.g. backticks, $(),
    // newlines) that would render misleadingly or be copy-pasted unsafely.
    const rawBin = (config as OclifConfig).bin ?? 'cli';
    const bin = String(rawBin).replace(/[^A-Za-z0-9._-]/g, '_');

    if (suggestion !== null) {
      process.stderr.write(
        `Unknown command: "${inputPath}"\n` +
          `Did you mean: ${suggestion}?\n` +
          `\nWe highly encourage you to alias this\n` +
          `so you never have to think about this again:\n` +
          `  ${bin} ${suggestion} --alias-from ${inputPath}\n` +
          `  --alias-reason "why was this your gut reaction?"\n`
      );
    } else {
      process.stderr.write(`Unknown command: "${inputPath}"\n`);
    }

    if (options.onUnknownCommand) {
      options.onUnknownCommand({ inputCmd: inputPath, suggestion });
      return;
    }

    // H8: Use this.exit(1) (oclif convention) instead of process.exit(1)
    // so oclif's cleanup hooks and error pipeline run properly.
    this.exit(1);
  };

  return hook;
}
