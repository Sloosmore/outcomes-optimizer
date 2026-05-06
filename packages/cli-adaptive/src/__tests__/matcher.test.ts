import { describe, it, expect } from 'vitest';
import { match, flattenCommands } from '../matcher.js';

const COMMANDS = [
  'resource link',
  'resource list',
  'resource create',
  'sandbox execute',
  'sandbox provision',
  'sandbox destroy',
  'health check status',
  'health check ping',
];

describe('match - structural matching', () => {
  it('leaf match: "link" matches "resource link" with confidence > 0.9 (NOT "resource list")', () => {
    const result = match('link', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('resource link');
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('leaf match: "execute" matches "sandbox execute"', () => {
    const result = match('execute', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('sandbox execute');
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('leaf match: "provision" matches "sandbox provision"', () => {
    const result = match('provision', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('sandbox provision');
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('leaf match: "list" matches "resource list"', () => {
    const result = match('list', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('resource list');
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('leaf match: "status" matches "health check status"', () => {
    const result = match('status', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('health check status');
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('structural match wins over levenshtein: "link" (distance 1 from "list") returns "resource link" not "resource list"', () => {
    // "link" is distance 1 from "list" via levenshtein, but exact leaf match to "resource link"
    // Structural match must win
    const result = match('link', COMMANDS);
    expect(result!.command).toBe('resource link');
  });

  it('prefix match: "resource" matches a resource command with confidence 0.8', () => {
    const result = match('resource', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
    expect(result!.command).toMatch(/^resource/);
  });

  it('returns null for empty candidates', () => {
    const result = match('anything', []);
    expect(result).toBeNull();
  });

  it('levenshtein fallback for close typos', () => {
    const result = match('destroi', COMMANDS);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('sandbox destroy');
  });
});

describe('flattenCommands', () => {
  it('converts nested arrays to flat space-joined strings', () => {
    const input = [
      ['resource', 'link'],
      ['sandbox', 'execute'],
      ['health', 'check', 'status'],
    ];
    const result = flattenCommands(input);
    expect(result).toEqual([
      'resource link',
      'sandbox execute',
      'health check status',
    ]);
  });

  it('handles single-word commands', () => {
    const result = flattenCommands([['help'], ['version']]);
    expect(result).toEqual(['help', 'version']);
  });
});
