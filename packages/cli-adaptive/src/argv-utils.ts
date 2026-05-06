/**
 * Strip --alias-from and --alias-reason flags (and their values) from argv.
 * Returns the cleaned argv plus extracted values.
 * Shared by the Commander and yargs adapters.
 */
export function extractAliasFlags(argv: string[]): {
  cleaned: string[];
  aliasFrom: string | null;
  aliasReason: string | null;
} {
  const cleaned: string[] = [];
  let aliasFrom: string | null = null;
  let aliasReason: string | null = null;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--alias-from') {
      aliasFrom = argv[i + 1] ?? null;
      i += 2;
    } else if (arg.startsWith('--alias-from=')) {
      aliasFrom = arg.slice('--alias-from='.length);
      i++;
    } else if (arg === '--alias-reason') {
      aliasReason = argv[i + 1] ?? null;
      i += 2;
    } else if (arg.startsWith('--alias-reason=')) {
      aliasReason = arg.slice('--alias-reason='.length);
      i++;
    } else {
      cleaned.push(arg);
      i++;
    }
  }

  return { cleaned, aliasFrom, aliasReason };
}

/**
 * Strip terminal control characters from a string before emitting it to stderr.
 * Prevents ANSI escape sequences in user-supplied input from manipulating the terminal.
 */
export function sanitizeForOutput(value: string): string {
  return value.replace(/[\x00-\x1f\x7f\x1b]/g, '');
}

/**
 * Sanitize a CLI binary name for use as a filesystem path component.
 * Prevents path traversal (e.g. ../../.ssh) via program.name() or config.bin.
 */
export function sanitizeBinName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
}
