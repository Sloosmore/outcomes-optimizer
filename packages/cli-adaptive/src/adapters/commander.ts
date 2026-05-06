import { Command, type ParseOptions } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AliasStore } from '../alias-store.js';
import { FileTraceAdapter } from '../trace.js';
import { match } from '../matcher.js';
import { extractAliasFlags, sanitizeForOutput, sanitizeBinName } from '../argv-utils.js';
import type { AdaptiveOptions } from '../types.js';

/**
 * Collect all registered command names from a Commander program.
 * Returns full command paths relative to the program root.
 */
function collectCommands(program: Command, prefix = ''): string[] {
  const result: string[] = [];
  for (const cmd of program.commands) {
    const fullName = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
    result.push(fullName);
    if (cmd.commands.length > 0) {
      result.push(...collectCommands(cmd, fullName));
    }
  }
  return result;
}

/**
 * Build the set of flags (long and short forms) that take an explicit value
 * from a Commander program's option list. Boolean flags are NOT in this set.
 * Used by findFirstCommand / resolveCommandPath to skip only genuine option values.
 *
 * Limitation: this function only inspects `program.options` — i.e. options
 * registered at the root of the program. It does NOT walk the subcommand tree
 * to collect value-taking flags declared inside `program.command(...).option(...)`.
 * As a result, argv like `cli sub --scoped-value-flag foo bar` may classify
 * `foo` as the command token instead of the value of `--scoped-value-flag`,
 * because `--scoped-value-flag` is not known at the root level.
 *
 * Walking the subcommand tree was intentionally avoided: it requires matching
 * the argv prefix against the command tree to know which subcommand's options
 * apply at each token position, and that is the high-risk change this function
 * was explicitly designed to avoid. If you need subcommand flag detection,
 * pre-register all subcommand option names at the root level (e.g. via
 * `program.option('--scoped-value-flag <value>', '...')`) so this builder picks
 * them up.
 */
function buildValueTakingFlags(program: Command): Set<string> {
  const flags = new Set<string>();
  for (const opt of program.options) {
    // required/optional mean the flag takes a value; boolean flags have neither
    if (opt.required || opt.optional) {
      if (opt.long) flags.add(opt.long);
      if (opt.short) flags.add(opt.short);
    }
  }
  return flags;
}

/**
 * Find the first non-option token in argv that is not the value of a preceding
 * value-taking flag. Uses the program's known option definitions so that boolean
 * flags (e.g. `--verbose`) are NOT treated as value consumers.
 *
 * e.g. `node cli --log-level debug resource link` → `resource` (debug is flag value)
 * e.g. `node cli --verbose resource link`         → `resource` (verbose is boolean)
 */
function findFirstCommand(
  program: Command,
  argv: string[],
  from: ParseOptions['from'] = 'node'
): string | null {
  const startIndex = from === 'node' || from === 'electron' ? 2 : 0;
  const valueTakingFlags = buildValueTakingFlags(program);
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('-')) continue;
    // Skip only if the previous flag is known to take a value (not a boolean flag)
    const prev = i > startIndex ? argv[i - 1] : null;
    if (prev !== null && prev.startsWith('-') && !prev.includes('=') && valueTakingFlags.has(prev)) continue;
    return arg;
  }
  return null;
}

/**
 * Walk the program's command tree to resolve the full command path from argv tokens.
 * Uses program option metadata to correctly skip only value-taking flag arguments.
 * e.g. ['resource', 'link', 'foo'] → 'resource link'
 */
function resolveCommandPath(program: Command, argv: string[]): string {
  const valueTakingFlags = buildValueTakingFlags(program);
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-')) continue;
    const prev = i > 0 ? argv[i - 1] : null;
    if (prev !== null && prev.startsWith('-') && !prev.includes('=') && valueTakingFlags.has(prev)) continue;
    tokens.push(a);
  }
  const pathParts: string[] = [];
  let current: Command = program;

  for (const token of tokens) {
    const sub = current.commands.find(c => c.name() === token || c.aliases().includes(token));
    if (sub) {
      pathParts.push(sub.name());
      current = sub;
    } else {
      break;
    }
  }

  return pathParts.join(' ');
}

/**
 * Wrap a Commander program with adaptive alias support.
 *
 * Behavior:
 * - If argv contains `--alias-from <cmd>`: executes the real command, then creates alias on success
 * - If argv matches a known alias: silently rewrites argv, executes real command
 * - If argv contains an unknown command: prints suggestion to stderr and sets exitCode 1
 */
export function withAdaptiveAliases(
  program: Command,
  options: AdaptiveOptions = {}
): Command {
  // H4: Default storage path is scoped to the CLI's bin name to avoid cross-CLI collisions
  // Sanitize bin to prevent path traversal via a malicious program.name() value
  const bin = sanitizeBinName(program.name() || 'default');
  const storagePath = options.storagePath ?? join(homedir(), '.cli-adaptive', bin);
  const store = new AliasStore(storagePath);
  const tracer =
    options.traceAdapter ?? new FileTraceAdapter(storagePath);

  // M4: Guard against double-registration if withAdaptiveAliases is called twice
  const alreadyRegistered = program.options.some((o) => o.long === '--alias-from');
  if (!alreadyRegistered) {
    program
      .option(
        '--alias-from <shorthand>',
        'create an alias: map <shorthand> to the current command'
      )
      .option(
        '--alias-reason <reason>',
        'describe why this alias makes sense (used with --alias-from)'
      );
  }

  const originalParseAsync = program.parseAsync.bind(program);

  program.parseAsync = async function (
    argv?: readonly string[],
    parseOptions?: ParseOptions
  ): Promise<Command> {
    // Work with a mutable copy
    let workingArgv: string[] = argv ? [...argv] : [...process.argv];

    // 1. Extract alias flags before any other processing
    let { cleaned, aliasFrom, aliasReason } = extractAliasFlags(workingArgv);
    workingArgv = cleaned;

    // M5: Reject --alias-from values that look like flags (e.g. --alias-from --other-flag)
    if (aliasFrom !== null && aliasFrom.startsWith('-')) {
      process.stderr.write(`Warning: --alias-from value "${aliasFrom}" looks like a flag and was ignored.\n`);
      aliasFrom = null;
    }

    // Determine where command tokens start based on parse mode
    const from = parseOptions?.from ?? 'node';
    const cmdStart = from === 'node' || from === 'electron' ? 2 : 0;

    // Collect all known commands from the program
    const knownCommands = collectCommands(program);
    const programName = program.name() || 'cli';

    // Find the first non-option token (the command being invoked)
    const inputCmd = findFirstCommand(program, workingArgv, from);

    if (inputCmd !== null) {
      // Check if it's already a known command (exact match)
      const isKnown = knownCommands.some(
        (c) => c === inputCmd || c.split(' ')[0] === inputCmd
      );

      // Check alias store for this command (before --alias-from handling)
      if (!aliasFrom) {
        const aliasTarget = store.findAlias(inputCmd);
        if (aliasTarget !== null) {
          // Silently rewrite argv: replace inputCmd with the alias target parts
          const targetParts = aliasTarget.trim().split(/\s+/).filter(Boolean);
          const cmdIndex = workingArgv.indexOf(inputCmd, cmdStart);
          if (cmdIndex !== -1) {
            workingArgv.splice(cmdIndex, 1, ...targetParts);
          }
          store.recordHit(inputCmd);
          return originalParseAsync(workingArgv, parseOptions);
        }
      }

      // Skip suggestion if --help/-h is present (let Commander handle it)
      const userArgs = workingArgv.slice(cmdStart);
      const hasHelpFlag = userArgs.some(a => a === '--help' || a === '-h');

      // If not known, not an alias, and no help flag — try structural match
      if (!isKnown && inputCmd !== 'help' && !hasHelpFlag) {
        const result = match(inputCmd, knownCommands);
        const suggestion = result?.command ?? null;
        const confidence = result?.confidence ?? null;

        tracer.logAttempt({
          command: workingArgv.slice(cmdStart),
          suggestion,
          confidence,
          timestamp: new Date().toISOString(),
          aliasCreated: false,
        });

        const safeInputCmd = sanitizeForOutput(inputCmd);
        if (suggestion !== null) {
          process.stderr.write(
            `Unknown command: "${safeInputCmd}"\n` +
              `Did you mean: ${suggestion}?\n` +
              `\nWe highly encourage you to alias this\n` +
              `so you never have to think about this again:\n` +
              `  ${programName} ${suggestion} --alias-from ${safeInputCmd}\n` +
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
        return program;
      }
    }

    // Execute the command. Detect failure via either a thrown exception OR a
    // non-zero post-run exitCode. To avoid confusing a failing command with a
    // caller that pre-set exitCode=1 (where the command fails but leaves the
    // value unchanged), we snapshot the caller's exitCode, reset it to
    // undefined before parseAsync, and restore it on success. Any non-zero
    // value observed afterwards is therefore attributable to the command
    // itself, not to caller state.
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    let result: Command;
    let commandSucceeded = true;
    try {
      result = await originalParseAsync(workingArgv, parseOptions);
    } catch (err) {
      commandSucceeded = false;
      // Restore caller's pre-existing exitCode before re-throwing so the
      // exception path does not leave process.exitCode in the temporary
      // `undefined` state we set prior to parseAsync.
      if (process.exitCode === undefined) {
        process.exitCode = savedExitCode;
      }
      throw err;
    } finally {
      // Determine whether the command signaled failure via exitCode. Because
      // we reset exitCode to undefined before parseAsync, any non-zero value
      // here is attributable to the command itself (not caller state).
      const commandFailed =
        process.exitCode !== undefined && process.exitCode !== 0;

      // Restore caller's pre-existing exitCode on success paths so we do not
      // clobber state the caller set for unrelated reasons. On failure (thrown
      // exception or non-zero exitCode) we preserve the failure signal.
      if (commandSucceeded && !commandFailed && process.exitCode === undefined) {
        process.exitCode = savedExitCode;
      }

      // If --alias-from was provided, persist alias only on success.
      // Wrapped in try-catch so a secondary failure here never masks the original error.
      if (aliasFrom !== null && commandSucceeded && !commandFailed) {
        try {
          const resolvedPath = resolveCommandPath(program, workingArgv.slice(cmdStart));
          if (resolvedPath) {
            store.addAlias(aliasFrom, resolvedPath, aliasReason ?? undefined);
            process.stderr.write(
              `Alias created: "${aliasFrom}" → "${resolvedPath}"\n`
            );

            tracer.logAttempt({
              command: workingArgv.slice(cmdStart),
              suggestion: resolvedPath,
              confidence: 1.0,
              timestamp: new Date().toISOString(),
              aliasCreated: true,
              reason: aliasReason ?? undefined,
            });
          }
        } catch (aliasErr) {
          process.stderr.write(`Warning: alias creation failed: ${(aliasErr as Error).message}\n`);
        }
      }
    }

    return result!;
  };

  return program;
}
