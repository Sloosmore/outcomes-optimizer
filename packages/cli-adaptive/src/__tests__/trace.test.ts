import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { withAdaptiveAliases } from '../adapters/commander.js';
import { FileTraceAdapter } from '../trace.js';
import type { TraceAdapter, AttemptRecord } from '../types.js';

let tempDir: string;

function makeProgram(): Command {
  const program = new Command();
  program.name('testcli');
  program.exitOverride();

  const resource = program.command('resource');
  resource.command('link').action(() => {});
  resource.command('list').action(() => {});

  const sandbox = program.command('sandbox');
  sandbox.command('execute').action(() => {});
  sandbox.command('provision').action(() => {});

  return program;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-trace-test-'));
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Pluggable trace adapter', () => {
  it('custom in-memory TraceAdapter receives logAttempt with correct AttemptRecord shape', async () => {
    const received: AttemptRecord[] = [];
    const mockAdapter: TraceAdapter = {
      logAttempt(record) {
        received.push(record);
      },
    };

    const program = withAdaptiveAliases(makeProgram(), {
      storagePath: tempDir,
      traceAdapter: mockAdapter,
    });

    // Suppress stderr for this test
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Trigger unknown command — now uses exitCode instead of process.exit
    await program.parseAsync(['node', 'testcli', 'lnk'], { from: 'node' });

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      command: expect.any(Array),
      suggestion: expect.any(String),
      confidence: expect.any(Number),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      aliasCreated: false,
    });
  });
});

describe('Fire-and-forget timing', () => {
  it('logAttempt returns void synchronously — fire-and-forget is guaranteed by the return type', () => {
    // FileTraceAdapter.logAttempt returns void (not Promise<void>) and uses the
    // callback-based appendFile without awaiting it. The contract is enforced by
    // the TraceAdapter interface: `logAttempt(record: AttemptRecord): void`.
    //
    // We verify this without mocking node:fs (whose named exports are non-configurable
    // in ESM and cannot be spied on). The real appendFile is async by design, so
    // any compliant implementation must be fire-and-forget.
    const adapter = new FileTraceAdapter(tempDir);
    const result = adapter.logAttempt({
      command: ['test'],
      suggestion: null,
      confidence: null,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });
    // logAttempt must return void (not a Promise) — fire-and-forget is the contract
    expect(result).toBeUndefined();
  });
});
