import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { withAdaptiveAliases } from '../adapters/commander.js';
import { AliasStore } from '../alias-store.js';

let tempDir: string;

function makeProgram(): Command {
  const program = new Command();
  program.name('testcli');
  program.exitOverride(); // prevent process.exit during tests

  const resource = program.command('resource');
  resource.command('link').argument('[target]').action(() => {});
  resource.command('list').action(() => {});

  const sandbox = program.command('sandbox');
  sandbox.command('execute').action(() => {});
  sandbox.command('provision').action(() => {});

  return program;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-commander-test-'));
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Commander adapter - unknown command', () => {
  it('Test 1: unknown command outputs suggestion with all 5 required strings', async () => {
    const program = withAdaptiveAliases(makeProgram(), {
      storagePath: tempDir,
    });

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrLines.push(String(data));
        return true;
      });

    await program.parseAsync(['node', 'testcli', 'lnk'], { from: 'node' });

    const output = stderrLines.join('');

    // All 5 required strings
    expect(output).toContain('Unknown command');
    expect(output).toContain('Did you mean:');
    expect(output).toContain('We highly encourage you to alias this');
    expect(output).toContain('--alias-from');
    expect(output).toContain('--alias-reason');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });
});

describe('Commander adapter - alias creation', () => {
  it('Test 2: --alias-from + --alias-reason creates alias file and trace file', async () => {
    const program = withAdaptiveAliases(makeProgram(), {
      storagePath: tempDir,
    });

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrLines.push(String(data));
        return true;
      });

    await program.parseAsync(
      [
        'node',
        'testcli',
        'resource',
        'link',
        '--alias-from',
        'lnk',
        '--alias-reason',
        'shorthand',
      ],
      { from: 'node' }
    );

    // Alias file should exist
    const aliasFile = join(tempDir, 'aliases.json');
    expect(existsSync(aliasFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(aliasFile, 'utf-8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].from).toBe('lnk');
    expect(parsed[0].to).toBe('resource link');
    expect(parsed[0].reason).toBe('shorthand');

    // stderr should confirm alias creation
    const output = stderrLines.join('');
    expect(output).toContain('Alias created:');
    expect(output).toContain('lnk');

    // Trace file should be written (fire-and-forget, give it a moment)
    await new Promise((r) => setTimeout(r, 50));
    const traceFile = join(tempDir, 'traces.jsonl');
    expect(existsSync(traceFile)).toBe(true);

    stderrSpy.mockRestore();
  });
});

describe('Commander adapter - transparent alias rewrite', () => {
  it('Test 3: alias rewrite calls action handler, stderr empty, hits incremented', async () => {
    // Pre-create an alias that maps 'lnk' to 'resource link'
    const store = new AliasStore(tempDir);
    store.addAlias('lnk', 'resource link');

    const program = withAdaptiveAliases(makeProgram(), {
      storagePath: tempDir,
    });

    const stderrOutput: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrOutput.push(String(data));
        return true;
      });

    // 'lnk' should silently rewrite to 'resource link'
    await program.parseAsync(['node', 'testcli', 'lnk', 'myresource'], {
      from: 'node',
    });

    // stderr should be empty (silent rewrite)
    expect(stderrOutput.join('')).toBe('');

    // hits should be incremented
    const updatedStore = new AliasStore(tempDir);
    const entries = updatedStore.getAll();
    const entry = entries.find((e) => e.from === 'lnk');
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(1);

    stderrSpy.mockRestore();
  });
});
