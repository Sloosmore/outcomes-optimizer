import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliasStore } from '../alias-store.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AliasStore - addAlias and read file', () => {
  it('writes alias with all required fields in correct JSON format', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('lnk', 'resource link', 'shorthand for link');

    const filePath = join(tempDir, 'aliases.json');
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf-8');
    // Assert pretty-printed (2-space indent)
    expect(raw).toMatch(/^\[/);
    expect(raw).toContain('  ');

    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const entry = parsed[0];
    expect(entry.from).toBe('lnk');
    expect(entry.to).toBe('resource link');
    expect(entry.reason).toBe('shorthand for link');
    // ISO 8601 timestamps
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.hits).toBe(0);
  });

  it('findAlias returns the target command', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('exec', 'sandbox execute');
    expect(store.findAlias('exec')).toBe('sandbox execute');
  });

  it('findAlias returns null for unknown alias', () => {
    const store = new AliasStore(tempDir);
    expect(store.findAlias('nonexistent')).toBeNull();
  });

  it('recordHit increments hits and updates lastUsed', async () => {
    const store = new AliasStore(tempDir);
    store.addAlias('exec', 'sandbox execute');

    const before = new Date();
    // Small delay to ensure lastUsed timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    store.recordHit('exec');

    const entries = store.getAll();
    expect(entries[0].hits).toBe(1);
    expect(new Date(entries[0].lastUsed).getTime()).toBeGreaterThanOrEqual(
      before.getTime()
    );
  });

  it('getAll returns all stored aliases', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('a', 'resource link');
    store.addAlias('b', 'sandbox execute');
    expect(store.getAll()).toHaveLength(2);
  });

  it('alias without reason does not include reason field', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('lnk', 'resource link');

    const raw = readFileSync(join(tempDir, 'aliases.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed[0].reason).toBeUndefined();
  });
});

describe('AliasStore - N=1 test: no alias file created from unknown commands alone', () => {
  it('does not create aliases.json when no addAlias is called', () => {
    // Simulate 5 unknown command attempts without --alias-from
    // AliasStore is only instantiated; no addAlias called
    const store = new AliasStore(tempDir);

    // Access via findAlias (simulating lookup for unknown commands)
    for (let i = 0; i < 5; i++) {
      store.findAlias(`unknown-command-${i}`);
    }

    const filePath = join(tempDir, 'aliases.json');
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('AliasStore - input validation (validateToken)', () => {
  it('rejects alias names with path traversal characters', () => {
    const store = new AliasStore(tempDir);
    expect(() => store.addAlias('../etc/passwd', 'target')).toThrow(/Invalid/);
  });

  it('rejects alias names with shell metacharacters', () => {
    const store = new AliasStore(tempDir);
    expect(() => store.addAlias('cmd;evil', 'target')).toThrow(/Invalid/);
  });

  it('rejects alias targets with shell metacharacters', () => {
    const store = new AliasStore(tempDir);
    expect(() => store.addAlias('good', 'target; rm -rf /')).toThrow(/Invalid/);
  });

  it('rejects empty alias names', () => {
    const store = new AliasStore(tempDir);
    expect(() => store.addAlias('', 'target')).toThrow(/Invalid/);
  });

  it('accepts valid multi-word targets (space-separated)', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('lnk', 'resource link');
    expect(store.findAlias('lnk')).toBe('resource link');
  });

  it('accepts alias names with dots and dashes', () => {
    const store = new AliasStore(tempDir);
    store.addAlias('my-cmd.v2', 'sandbox execute');
    expect(store.findAlias('my-cmd.v2')).toBe('sandbox execute');
  });
});

describe('AliasStore - mergeFromDisk concurrency semantics', () => {
  it('addAlias preserves entries written concurrently by another process', () => {
    // Simulates: process A creates store1 and writes 'exec'. Meanwhile, process B
    // writes 'lnk' directly to disk. When process A calls addAlias again, it should
    // merge and preserve 'lnk' from disk.
    const store1 = new AliasStore(tempDir);
    store1.addAlias('exec', 'sandbox execute');

    // Simulate a concurrent write from another process by creating a second instance
    const store2 = new AliasStore(tempDir);
    store2.addAlias('lnk', 'resource link');

    // Now store1 adds another alias — mergeFromDisk should pick up 'lnk'
    store1.addAlias('prv', 'sandbox provision');

    // All three entries should be present after the merge+write
    const store3 = new AliasStore(tempDir);
    expect(store3.findAlias('exec')).toBe('sandbox execute');
    expect(store3.findAlias('lnk')).toBe('resource link');
    expect(store3.findAlias('prv')).toBe('sandbox provision');
  });
});
