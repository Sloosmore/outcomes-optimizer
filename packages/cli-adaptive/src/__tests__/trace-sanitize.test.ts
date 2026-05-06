import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTraceAdapter } from '../trace.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-adaptive-sanitize-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('FileTraceAdapter - secret redaction (sanitizeArgv)', () => {
  it('redacts --token value in traces', async () => {
    const adapter = new FileTraceAdapter(tempDir);
    adapter.logAttempt({
      command: ['deploy', '--token', 'sk-secret-123'],
      suggestion: null,
      confidence: null,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });
    // Give fire-and-forget write time to complete
    await new Promise((r) => setTimeout(r, 50));

    const traceFile = join(tempDir, 'traces.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const content = readFileSync(traceFile, 'utf-8');
    expect(content).not.toContain('sk-secret-123');
    expect(content).toContain('[REDACTED]');
  });

  it('redacts --password value in traces', async () => {
    const adapter = new FileTraceAdapter(tempDir);
    adapter.logAttempt({
      command: ['login', '--password', 'hunter2'],
      suggestion: null,
      confidence: null,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    const traceFile = join(tempDir, 'traces.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const content = readFileSync(traceFile, 'utf-8');
    expect(content).not.toContain('hunter2');
    expect(content).toContain('[REDACTED]');
  });

  it('redacts --token=value inline form in traces', async () => {
    const adapter = new FileTraceAdapter(tempDir);
    adapter.logAttempt({
      command: ['deploy', '--token=sk-secret-456'],
      suggestion: null,
      confidence: null,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    const traceFile = join(tempDir, 'traces.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const content = readFileSync(traceFile, 'utf-8');
    expect(content).not.toContain('sk-secret-456');
    expect(content).toContain('[REDACTED]');
  });

  it('does not redact non-secret flags', async () => {
    const adapter = new FileTraceAdapter(tempDir);
    adapter.logAttempt({
      command: ['deploy', '--env', 'production'],
      suggestion: null,
      confidence: null,
      timestamp: new Date().toISOString(),
      aliasCreated: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    const traceFile = join(tempDir, 'traces.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const content = readFileSync(traceFile, 'utf-8');
    expect(content).toContain('production');
  });
});
