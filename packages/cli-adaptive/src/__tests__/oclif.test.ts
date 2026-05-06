import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAdaptiveAliasesOclif } from '../adapters/oclif.js';
import { AliasStore } from '../alias-store.js';

let tempDir: string;

/**
 * Minimal mock oclif config with enough structure for the hook to work.
 * oclif uses colon-separated command IDs internally.
 */
function makeMockConfig(commandIds: string[], bin = 'testcli') {
  return {
    bin,
    commandIDs: commandIds,
    commands: commandIds.map((id) => ({ id })),
    runCommand: vi.fn(),
  };
}

/**
 * Minimal mock Hook.Context — satisfies the `this` binding requirement.
 */
const mockContext = {
  config: {} as any,
  debug: () => {},
  error: (msg: any) => { throw new Error(String(msg)); },
  exit: (code?: number) => { throw new Error(`exit:${code ?? 0}`); },
  log: () => {},
  warn: () => {},
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-oclif-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('oclif adapter - unknown command suggestion', () => {
  it('Test 1: unknown command id suggests a match with all 5 required strings', async () => {
    const hook = withAdaptiveAliasesOclif({ storagePath: tempDir });

    const config = makeMockConfig([
      'resource:link',
      'resource:list',
      'sandbox:provision',
      'sandbox:execute',
    ]);

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrLines.push(String(data));
        return true;
      });

    // H8: The adapter now uses this.exit(1) instead of process.exit(1);
    // mockContext.exit throws Error('exit:1') to let the test catch it.
    await expect(
      hook.call(mockContext as any, {
        id: 'link',
        argv: [],
        config: config as any,
        context: mockContext as any,
      })
    ).rejects.toThrow('exit:1');

    const output = stderrLines.join('');

    expect(output).toContain('Unknown command: "link"');
    expect(output).toContain('Did you mean:');
    expect(output).toContain('We highly encourage');
    expect(output).toContain('--alias-from link');
    expect(output).toContain('--alias-reason');

    stderrSpy.mockRestore();
  });
});

describe('oclif adapter - alias creation', () => {
  it('Test 2: alias can be pre-created and hook rewrites to the real command', async () => {
    // Pre-create alias: 'lnk' → 'resource link'
    const store = new AliasStore(tempDir);
    store.addAlias('resource lnk', 'resource link');

    const hook = withAdaptiveAliasesOclif({ storagePath: tempDir });

    const config = makeMockConfig([
      'resource:link',
      'resource:list',
      'sandbox:provision',
      'sandbox:execute',
    ]);

    const stderrOutput: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrOutput.push(String(data));
        return true;
      });

    await hook.call(mockContext as any, {
      id: 'resource:lnk',
      argv: [],
      config: config as any,
      context: mockContext as any,
    });

    // runCommand should have been called with the real command
    expect(config.runCommand).toHaveBeenCalledWith('resource:link', []);

    // stderr should be empty (transparent rewrite)
    expect(stderrOutput.join('')).toBe('');

    stderrSpy.mockRestore();
  });
});

describe('oclif adapter - transparent alias rewrite with hit counter', () => {
  it('Test 3: alias lookup increments hits', async () => {
    const store = new AliasStore(tempDir);
    store.addAlias('lnk', 'resource link');

    const hook = withAdaptiveAliasesOclif({ storagePath: tempDir });

    const config = makeMockConfig([
      'resource:link',
      'resource:list',
      'sandbox:provision',
      'sandbox:execute',
    ]);

    const stderrOutput: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data) => {
        stderrOutput.push(String(data));
        return true;
      });

    await hook.call(mockContext as any, {
      id: 'lnk',
      argv: [],
      config: config as any,
      context: mockContext as any,
    });

    // runCommand should have been called with the real command
    expect(config.runCommand).toHaveBeenCalledWith('resource:link', []);

    // stderr should be empty
    expect(stderrOutput.join('')).toBe('');

    // hits should be 1
    const updatedStore = new AliasStore(tempDir);
    const entries = updatedStore.getAll();
    const entry = entries.find((e) => e.from === 'lnk');
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(1);

    stderrSpy.mockRestore();
  });
});
