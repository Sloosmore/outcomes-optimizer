import type { Argv } from 'yargs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { AliasStore } from '../alias-store.js';
import { FileTraceAdapter } from '../trace.js';
import { match } from '../matcher.js';
import { extractAliasFlags, sanitizeForOutput, sanitizeBinName } from '../argv-utils.js';
import type { AdaptiveOptions } from '../types.js';

/**
 * Find the first non-option token in argv that is not the value of a preceding
 * value-taking flag. yargs parseAsync receives argv without node/script prefix.
 *
 * `booleanFlags` is the set of flag names (without leading dashes) that are known
 * to be boolean — they do NOT consume the next token as a value. Tokens following
 * a bare (non-`=`) boolean flag are NOT skipped.
 *
 * Example: `--retries 3 lnk` → `lnk` (`3` is value of `--retries`)
 * Example: `--verbose resource link` → `resource` (`--verbose` is boolean, not consuming `resource`)
 */
function findFirstToken(argv: string[], booleanFlags: Set<string> = new Set()): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('-')) continue;
    // Skip only if the previous bare flag is NOT a boolean flag
    const prev = i > 0 ? argv[i - 1] : null;
    if (prev !== null && prev.startsWith('-') && !prev.includes('=')) {
      const prevName = prev.replace(/^-+/, '');
      if (!booleanFlags.has(prevName)) continue;
    }
    return arg;
  }
  return null;
}

/**
 * Tokenize a command string while respecting single and double quotes.
 * Used when yargs `parseAsync` is called with a string instead of an array.
 *
 * Note: this is a small state machine, not a full shell parser. It does NOT
 * support backslash escapes inside quotes (e.g. `"he said \"hi\""`). If a
 * backslash is encountered inside a quoted region, this function throws a
 * clear error rather than silently producing a wrong tokenization. Callers
 * with complex shell semantics should pass a pre-tokenized `string[]` to
 * `parseAsync` instead of a raw string.
 */
function tokenizeArgString(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\') {
        throw new Error(
          'tokenizeArgString does not support backslash escapes inside quotes. ' +
            'Pass argv as string[] instead of string for complex arguments.'
        );
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Given the user-supplied non-flag tokens and the set of known command paths,
 * return the longest known path that is a prefix-match of the tokens. e.g.
 * tokens `['resource', 'link', 'foo']` with known `['resource', 'resource link']`
 * → `'resource link'`. Used so that aliasing on `resource link --alias-from lnk`
 * stores the full path, not just the first token.
 */
function findLongestMatchingCommand(
  knownCommands: string[],
  tokens: string[]
): string | null {
  let best: string | null = null;
  for (const c of knownCommands) {
    const parts = c.split(' ');
    if (parts.length > tokens.length) continue;
    let matches = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== tokens[i]) {
        matches = false;
        break;
      }
    }
    if (matches && (best === null || c.length > best.length)) {
      best = c;
    }
  }
  return best;
}

/**
 * Collect all command paths from a yargs command instance by introspecting handlers.
 * For each handler with a builder function, call it on a fresh yargs instance to
 * discover subcommands. Returns full paths like ['resource', 'resource link', 'sandbox'].
 *
 * This works regardless of whether commands were registered before or after
 * withAdaptiveAliasesYargs was called.
 */
function collectCommandPaths(
  cmdInstance: any,
  prefix: string,
  yargsFactory: () => Argv
): string[] {
  const paths: string[] = [];

  for (const [key, handler] of Object.entries<any>(cmdInstance.handlers)) {
    // Skip internal yargs commands (like $0)
    if (key.startsWith('$')) continue;
    const name = prefix ? `${prefix} ${key}` : key;
    paths.push(name);

    // If handler has a builder function, call it on a fresh sub-instance
    if (typeof handler.builder === 'function') {
      try {
        const subYargs = yargsFactory();
        handler.builder(subYargs);
        const subInternals = (subYargs as any).getInternalMethods?.();
        if (subInternals) {
          const subCmdInst = subInternals.getCommandInstance?.();
          if (
            subCmdInst &&
            Object.keys(subCmdInst.handlers).length > 0
          ) {
            const subPaths = collectCommandPaths(
              subCmdInst,
              name,
              yargsFactory
            );
            paths.push(...subPaths);
          }
        }
      } catch {
        // Silently skip if builder inspection fails
      }
    }
  }

  return paths;
}

/**
 * Wrap a yargs Argv instance with adaptive alias support.
 *
 * Behavior:
 * - If argv contains `--alias-from <cmd>`: creates alias, rewrites argv, executes real command
 * - If argv matches a known alias: silently rewrites argv, executes real command
 * - If argv contains an unknown command: prints suggestion to stderr and exits with code 1
 *
 * Supports both flat space-separated commands registered before OR after this call,
 * and nested subcommand builders. Command paths are collected lazily at parse time by
 * inspecting the registered handlers and calling builder functions on dummy instances.
 */
export function withAdaptiveAliasesYargs(
  cli: Argv,
  options: AdaptiveOptions = {}
): Argv {
  // H4: Default storage path is scoped to the script name to avoid cross-CLI collisions
  // Sanitize binName to prevent path traversal via a crafted argv[1] value
  const rawBinName = process.argv[1] ? basename(process.argv[1], '.js') : 'default';
  const binName = sanitizeBinName(rawBinName);
  const storagePath = options.storagePath ?? join(homedir(), '.cli-adaptive', binName);
  const store = new AliasStore(storagePath);
  const tracer = options.traceAdapter ?? new FileTraceAdapter(storagePath);

  // Wrap parseAsync to intercept before yargs processes
  const originalParseAsync = cli.parseAsync.bind(cli);
  Object.defineProperty(cli, 'parseAsync', {
    value: async function (
      args?: string | readonly string[],
      context?: object
    ) {
      // Normalize to string array. When given a string, tokenize while
      // respecting quoted substrings so `read --query "hello world"` is split
      // into 3 tokens, not 4. For complex shell semantics, callers should
      // pre-tokenize into an array.
      let workingArgv: string[] =
        args === undefined
          ? process.argv.slice(2)
          : typeof args === 'string'
          ? tokenizeArgString(args)
          : [...args];

      // Extract alias flags before any other processing
      let { cleaned, aliasFrom, aliasReason } = extractAliasFlags(workingArgv);
      workingArgv = cleaned;

      // M5: Reject --alias-from values that look like flags (e.g. --alias-from --other-flag)
      if (aliasFrom !== null && aliasFrom.startsWith('-')) {
        process.stderr.write(`Warning: --alias-from value "${aliasFrom}" looks like a flag and was ignored.\n`);
        aliasFrom = null;
      }

      // Resolve yargs module once per parseAsync invocation so we can use the same
      // reference for both the pre-execute and post-execute introspection paths.
      let yargsModule: typeof import('yargs').default | null = null;
      try {
        yargsModule = (await import('yargs')).default;
      } catch {
        // Dynamic import failed — proceed without yargs-based introspection
      }

      /**
       * Introspect the registered command tree via yargs internals.
       * Returns [] if yargs internals are unavailable or have changed shape.
       */
      function getKnownCommandsFromInternals(): string[] {
        try {
          const internals = (cli as any).getInternalMethods?.();
          if (internals && yargsModule) {
            const cmdInstance = internals.getCommandInstance?.();
            if (cmdInstance) {
              return collectCommandPaths(
                cmdInstance,
                '',
                () => (yargsModule as any)([]).exitProcess(false)
              );
            }
          }
        } catch {
          // Introspection failed
        }
        return [];
      }

      // Get boolean flag names from yargs' option registry so findFirstToken
      // does not misidentify tokens after boolean flags as option values.
      const booleanFlags: Set<string> = new Set();
      try {
        const opts = (cli as any).getOptions?.();
        if (opts?.boolean && Array.isArray(opts.boolean)) {
          for (const f of opts.boolean) {
            if (typeof f !== 'string') continue;
            booleanFlags.add(f);
            // Also add every alias (short and long forms) so `-v` is treated
            // as boolean when `--verbose` is boolean via `.option('v', {alias: 'verbose', type: 'boolean'})`.
            const aliases = opts.alias?.[f];
            if (Array.isArray(aliases)) {
              for (const a of aliases) {
                if (typeof a === 'string') booleanFlags.add(a);
              }
            }
          }
        }
      } catch {
        // getOptions unavailable — booleanFlags stays empty (conservative: skip all)
      }

      // The first non-option token is the command being invoked
      const inputCmd = findFirstToken(workingArgv, booleanFlags);

      // Disable yargs' own exit handling so we can control it
      cli.exitProcess(false);

      if (inputCmd !== null) {
        // Lazily collect all known commands by introspecting yargs internals at parse time.
        // This handles commands registered both before and after withAdaptiveAliasesYargs.
        const knownCommands = getKnownCommandsFromInternals();

        // knownCommands is populated from introspection; stays empty if yargs internals changed

        // Check if the first token matches a known command or its first word
        const isKnown = knownCommands.some(
          (c) => c === inputCmd || c.split(' ')[0] === inputCmd
        );

        // Check alias store for this command (before --alias-from handling)
        if (aliasFrom === null) {
          const aliasTarget = store.findAlias(inputCmd);
          if (aliasTarget !== null) {
            const targetParts = aliasTarget.trim().split(/\s+/).filter(Boolean);
            const cmdIndex = workingArgv.indexOf(inputCmd);
            if (cmdIndex !== -1) {
              workingArgv.splice(cmdIndex, 1, ...targetParts);
            }
            store.recordHit(inputCmd);
            return originalParseAsync(workingArgv, context);
          }
        }

        // If not known and no alias, try structural match
        if (!isKnown && aliasFrom === null) {
          const result = match(inputCmd, knownCommands);
          const suggestion = result?.command ?? null;
          const confidence = result?.confidence ?? null;

          tracer.logAttempt({
            command: workingArgv,
            suggestion,
            confidence,
            timestamp: new Date().toISOString(),
            aliasCreated: false,
          });

          const scriptName =
            (cli as any).parsed?.['$0'] ??
            (cli as any)._scriptName ??
            'cli';

          const safeInputCmd = sanitizeForOutput(inputCmd);
          if (suggestion !== null) {
            process.stderr.write(
              `Unknown command: "${safeInputCmd}"\n` +
                `Did you mean: ${suggestion}?\n` +
                `\nWe highly encourage you to alias this\n` +
                `so you never have to think about this again:\n` +
                `  ${scriptName} ${suggestion} --alias-from ${safeInputCmd}\n` +
                `  --alias-reason "why was this your gut reaction?"\n`
            );
          } else {
            process.stderr.write(`Unknown command: "${safeInputCmd}"\n`);
          }

          if (options.onUnknownCommand) {
            options.onUnknownCommand({ inputCmd, suggestion });
          } else {
            process.exitCode = 1;
          }
          return { _: [], $0: '' } as any;
        }
      }

      // Execute the command. Snapshot the caller's exitCode and reset it to
      // undefined so any non-zero value we observe after parseAsync is
      // attributable to the command itself, not to caller state. This avoids
      // the pitfall where a caller pre-set exitCode=1 and a failing command
      // that leaves exitCode at 1 looks identical to success.
      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      let result: any;
      try {
        result = await originalParseAsync(workingArgv, context);
      } catch (err) {
        // Restore caller's pre-existing exitCode before re-throwing.
        if (process.exitCode === undefined) {
          process.exitCode = savedExitCode;
        }
        throw err;
      }

      // If --alias-from was provided, persist alias after successful execution.
      // Resolve the alias target to the longest matching known command path so
      // that aliasing `lnk` to `resource link` stores `resource link`, not just
      // `resource`. Falls back to the bare inputCmd if no longer path matches.
      // M: Only persist if the command did not signal failure via exitCode.
      const commandFailed =
        process.exitCode !== undefined && process.exitCode !== 0;

      // On success, restore the caller's pre-existing exitCode so we do not
      // clobber state they set for unrelated reasons.
      if (!commandFailed && process.exitCode === undefined) {
        process.exitCode = savedExitCode;
      }

      if (aliasFrom !== null && inputCmd !== null && !commandFailed) {
        // Reuse the same introspection path and yargs module resolved earlier
        const knownCommands = getKnownCommandsFromInternals();

        // Build the list of non-flag tokens the user actually typed (skipping
        // option values like `--retries 3`). Use booleanFlags to avoid treating
        // tokens after boolean flags as option values.
        const userTokens: string[] = [];
        for (let i = 0; i < workingArgv.length; i++) {
          const a = workingArgv[i]!;
          if (a.startsWith('-')) continue;
          const prev = i > 0 ? workingArgv[i - 1] : null;
          if (prev !== null && prev.startsWith('-') && !prev.includes('=')) {
            const prevName = prev.replace(/^-+/, '');
            if (!booleanFlags.has(prevName)) continue;
          }
          userTokens.push(a);
        }
        const aliasTarget =
          findLongestMatchingCommand(knownCommands, userTokens) ?? inputCmd;

        store.addAlias(aliasFrom, aliasTarget, aliasReason ?? undefined);
        process.stderr.write(
          `Alias created: "${aliasFrom}" → "${aliasTarget}"\n`
        );

        tracer.logAttempt({
          command: workingArgv,
          suggestion: aliasTarget,
          confidence: 1.0,
          timestamp: new Date().toISOString(),
          aliasCreated: true,
          reason: aliasReason ?? undefined,
        });
      }

      return result;
    },
    writable: true,
    configurable: true,
  });

  return cli;
}
