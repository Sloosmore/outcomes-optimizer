import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AliasEntry } from './types.js';

// H1 + C1: validate alias tokens to prevent injection via stored values
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate that every whitespace-separated word in `value` passes SAFE_TOKEN.
 * Returns the whitespace-normalized value (tabs/runs collapsed to single space)
 * so callers can store the normalized form and avoid lookup mismatches.
 */
function validateToken(label: string, value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const parts = normalized.split(' ');
  if (parts.length === 0 || parts[0] === '' || parts.some((p) => !SAFE_TOKEN.test(p))) {
    throw new Error(`Invalid ${label}: "${value}" — only alphanumeric, dot, dash, underscore tokens allowed`);
  }
  return normalized;
}

export class AliasStore {
  private readonly filePath: string;
  private entries: AliasEntry[];

  constructor(private readonly storagePath: string) {
    this.filePath = join(storagePath, 'aliases.json');
    this.entries = this.load();
  }

  /**
   * Parse and validate entries from the on-disk file without any recovery side-effects.
   * Used by mergeFromDisk() — returns [] on any error so merges are always safe.
   * Never renames or wipes the file; that is load()'s responsibility.
   */
  private readFromDisk(): AliasEntry[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const valid: AliasEntry[] = [];
      for (const entry of parsed) {
        try {
          if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
          validateToken('from', entry.from);
          validateToken('to', entry.to);
          valid.push(entry as AliasEntry);
        } catch {
          // Silently drop invalid entries — load() will warn at startup
        }
      }
      return valid;
    } catch {
      return [];
    }
  }

  private load(): AliasEntry[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('Invalid alias store shape');
      }
      // H1: Validate each entry on load — addAlias validates at write time, but
      // the file may be hand-edited or written by a different process. Entries with
      // invalid from/to values are silently dropped rather than propagated into argv.
      const valid: AliasEntry[] = [];
      for (const entry of parsed) {
        try {
          if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
          validateToken('from', entry.from);
          validateToken('to', entry.to);
          valid.push(entry as AliasEntry);
        } catch {
          process.stderr.write(`Warning: skipping invalid alias entry: ${JSON.stringify(entry)}\n`);
        }
      }
      return valid;
    } catch (err) {
      // File does not exist yet — start fresh silently
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      // H3: Only treat syntax/shape errors as corrupt-and-recover; re-surface others
      if (err instanceof SyntaxError || (err instanceof Error && err.message === 'Invalid alias store shape')) {
        // Corrupt file — rename and start fresh
        try {
          renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
          process.stderr.write(`Warning: ${this.filePath} was corrupt and has been renamed.\n`);
        } catch {
          // Rename failed — start fresh anyway
        }
        return [];
      }
      // For permission errors or other I/O errors, warn but don't wipe the file
      process.stderr.write(`Warning: could not read ${this.filePath}: ${(err as Error).message}\n`);
      return [];
    }
  }

  private save(): void {
    mkdirSync(this.storagePath, { recursive: true });
    // H1: Atomic write with per-call unique suffix to avoid intra-process collisions
    const tmpFile = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.entries, null, 2), 'utf-8');
      renameSync(tmpFile, this.filePath);
    } catch (err) {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  }

  findAlias(from: string): string | null {
    const entry = this.entries.find((e) => e.from === from);
    return entry ? entry.to : null;
  }

  /**
   * Re-read the on-disk file and merge any entries written by other processes
   * since this instance loaded. Mitigates lost-update races between concurrent
   * CLI invocations. In-memory entries take precedence over disk entries with
   * the same `from` key (the caller is about to write them).
   */
  private mergeFromDisk(): void {
    // Use readFromDisk (no corruption recovery, no stderr warnings) so that
    // a transient read error during a merge never renames or wipes the file.
    const onDisk = this.readFromDisk();
    if (onDisk.length === 0) return;
    const localKeys = new Set(this.entries.map((e) => e.from));
    for (const diskEntry of onDisk) {
      if (!localKeys.has(diskEntry.from)) {
        this.entries.push(diskEntry);
      }
    }
  }

  addAlias(from: string, to: string, reason?: string): void {
    // C1: Validate inputs to prevent injection via stored alias values.
    // validateToken returns the whitespace-normalized form — use normalized
    // locals throughout so lookups via findAlias always match even if the
    // caller used tabs or extra whitespace.
    const normalizedFrom = validateToken('alias shorthand (from)', from);
    const normalizedTo = validateToken('alias target (to)', to);
    const safeReason = reason !== undefined
      ? reason.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500)
      : undefined;

    const now = new Date().toISOString();
    // Re-read from disk to pick up concurrent writes from other processes
    this.mergeFromDisk();
    // Remove existing entry with same `from` key if present
    this.entries = this.entries.filter((e) => e.from !== normalizedFrom);
    const entry: AliasEntry = {
      from: normalizedFrom,
      to: normalizedTo,
      createdAt: now,
      lastUsed: now,
      hits: 0,
      ...(safeReason !== undefined ? { reason: safeReason } : {}),
    };
    this.entries.push(entry);
    this.save();
  }

  recordHit(from: string): void {
    // Re-read from disk to merge any concurrent additions before incrementing
    this.mergeFromDisk();
    const entry = this.entries.find((e) => e.from === from);
    if (entry) {
      entry.hits += 1;
      entry.lastUsed = new Date().toISOString();
      try {
        this.save();
      } catch {
        // Hit counting is best-effort — don't crash the CLI
      }
    }
  }

  getAll(): AliasEntry[] {
    return [...this.entries];
  }
}
