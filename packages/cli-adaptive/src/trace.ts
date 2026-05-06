import { appendFile, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceAdapter, AttemptRecord } from './types.js';

// H13: Flags whose next value may contain secrets — redact them before logging
const SECRET_FLAG_NAMES = new Set([
  '--password', '--passwd', '--secret', '--token', '--api-key', '--apikey',
  '--api-token', '--access-token', '--auth', '--credential', '--private-key',
  '--client-secret', '--client_secret',
]);

/**
 * Redact values following known secret flag names and `--flag=value` forms.
 * Only the command array is sanitized — suggestion/reason are not user-input.
 */
function sanitizeArgv(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.includes('=')) {
      const flagName = arg.split('=')[0]!.toLowerCase();
      result.push(SECRET_FLAG_NAMES.has(flagName) ? `${flagName}=[REDACTED]` : arg);
    } else if (SECRET_FLAG_NAMES.has(arg.toLowerCase())) {
      result.push(arg);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        result.push('[REDACTED]');
        i++;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Append-only JSONL trace adapter.
 *
 * Retention policy: NONE. This adapter has no automatic rotation, TTL, or
 * size cap — every call to `logAttempt` appends a new line to `traces.jsonl`
 * and the file grows unbounded. Callers are responsible for external rotation
 * (e.g. via `logrotate`, a cron job, or periodic truncation) if the trace
 * file grows beyond acceptable size for their use case.
 *
 * For high-volume deployments, consider implementing a custom `TraceAdapter`
 * with size-based rotation, batched writes, or a bounded ring-buffer instead
 * of using this adapter directly.
 */
export class FileTraceAdapter implements TraceAdapter {
  private readonly filePath: string;

  constructor(private readonly storagePath: string) {
    this.filePath = join(storagePath, 'traces.jsonl');
    // Ensure directory exists at construction time — idempotent, avoids TOCTOU
    mkdirSync(storagePath, { recursive: true });
  }

  logAttempt(record: AttemptRecord): void {

    // H13: Redact potential secrets from argv before persisting
    const sanitized: AttemptRecord = {
      ...record,
      command: sanitizeArgv(record.command),
    };

    const line = JSON.stringify(sanitized) + '\n';

    // Fire-and-forget: non-blocking, no await. Errors are swallowed so a
    // misconfigured path or full disk never crashes the CLI. Set
    // DEBUG_CLI_ADAPTIVE=1 to surface write failures during development.
    appendFile(this.filePath, line, 'utf-8', (err) => {
      if (err && process.env['DEBUG_CLI_ADAPTIVE']) {
        process.stderr.write(`cli-adaptive: trace write failed: ${err.message}\n`);
      }
    });
  }
}
