export interface AttemptRecord {
  command: string[];
  suggestion: string | null;
  confidence: number | null;
  timestamp: string; // ISO 8601
  aliasCreated: boolean;
  reason?: string;
}

export interface AliasEntry {
  from: string;
  to: string;
  createdAt: string; // ISO 8601
  lastUsed: string; // ISO 8601
  hits: number;
  reason?: string;
}

export interface TraceAdapter {
  logAttempt(record: AttemptRecord): void; // fire-and-forget, must not block
}

export interface AdaptiveOptions {
  storagePath?: string; // default: ~/.cli-adaptive
  traceAdapter?: TraceAdapter;
  /**
   * Called when an unknown command is encountered (after the suggestion has
   * been printed to stderr). Use this to control exit behavior instead of the
   * default `process.exitCode = 1` global side effect.
   */
  onUnknownCommand?: (info: {
    inputCmd: string;
    suggestion: string | null;
  }) => void;
}

export interface MatchResult {
  command: string; // the full command path e.g. "resource link"
  confidence: number; // 0-1
}
