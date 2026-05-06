import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { withAdaptiveAliasesYargs } from '../adapters/yargs.js';
import { AliasStore } from '../alias-store.js';

let tempDir: string;

/**
 * Build a yargs CLI using nested subcommands (registered before adapter is applied).
 * yargs flat space-separated commands ('resource link', 'resource list') conflict
 * when they share a first token — both register under 'resource' and the last wins.
 * Nested subcommands are the correct idiomatic yargs pattern for multi-level paths.
 */
function makeYargsCli() {
  let resourceLinkCalled = false;

  const cli = yargs([])
    .scriptName('testcli')
    .exitProcess(false)
    .command('resource', 'resource commands', (yargs: Argv) => {
      yargs
        .command('link', 'link a resource', {}, () => {
          resourceLinkCalled = true;
        })
        .command('list', 'list resources', {}, () => {});
    })
    .command('sandbox', 'sandbox commands', (yargs: Argv) => {
      yargs
        .command('provision', 'provision sandbox', {}, () => {})
        .command('execute', 'execute in sandbox', {}, () => {});
    });

  // Apply adapter after commands are registered — adapter inspects handlers at parse time
  withAdaptiveAliasesYargs(cli, { storagePath: tempDir });

  return { cli, getResourceLinkCalled: () => resourceLinkCalled };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-yargs-test-'));
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('yargs adapter - unknown command', () => {
  it('Test 1: unknown command outputs suggestion with all 5 required strings', async () => {
    const { cli } = makeYargsCli();

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrLines.push(String(data));
        return true;
      });

    // 'lnk' should be unknown and suggest a match
    await cli.parseAsync(['lnk']);

    const output = stderrLines.join('');

    expect(output).toContain('Unknown command: "lnk"');
    expect(output).toContain('Did you mean:');
    expect(output).toContain('We highly encourage');
    expect(output).toContain('--alias-from lnk');
    expect(output).toContain('--alias-reason');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
    process.exitCode = undefined;
  });
});

describe('yargs adapter - alias creation', () => {
  it('Test 2: --alias-from + --alias-reason creates alias file and trace file', async () => {
    const { cli } = makeYargsCli();

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrLines.push(String(data));
        return true;
      });

    // 'resource' is a known top-level command; alias-from creates: lnk → resource
    await cli.parseAsync([
      'resource',
      '--alias-from',
      'lnk',
      '--alias-reason',
      'shorthand',
    ]);

    // Alias file should exist
    const aliasFile = join(tempDir, 'aliases.json');
    expect(existsSync(aliasFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(aliasFile, 'utf-8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].from).toBe('lnk');
    expect(parsed[0].to).toBe('resource');
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

describe('yargs adapter - transparent alias rewrite', () => {
  it('Test 3: alias rewrite calls action handler, stderr empty, hits incremented', async () => {
    // Pre-create alias: 'res' → 'resource'
    const store = new AliasStore(tempDir);
    store.addAlias('res', 'resource');

    let resourceLinkCalled = false;

    const cli = yargs([])
      .scriptName('testcli')
      .exitProcess(false)
      .command('resource', 'resource commands', (yargs: Argv) => {
        yargs
          .command('link', 'link a resource', {}, () => {
            resourceLinkCalled = true;
          })
          .command('list', 'list resources', {}, () => {});
      })
      .command('sandbox', 'sandbox commands', (yargs: Argv) => {
        yargs
          .command('provision', 'provision sandbox', {}, () => {})
          .command('execute', 'execute in sandbox', {}, () => {});
      });

    withAdaptiveAliasesYargs(cli, { storagePath: tempDir });

    const stderrOutput: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrOutput.push(String(data));
        return true;
      });

    // 'res' should silently rewrite to 'resource', then 'link' is the subcommand
    await cli.parseAsync(['res', 'link']);

    // stderr should be empty (silent rewrite)
    expect(stderrOutput.join('')).toBe('');

    // action handler for 'resource link' must have been called
    expect(resourceLinkCalled).toBe(true);

    // hits should be 1
    const updatedStore = new AliasStore(tempDir);
    const entries = updatedStore.getAll();
    const entry = entries.find((e) => e.from === 'res');
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(1);

    stderrSpy.mockRestore();
  });
});
