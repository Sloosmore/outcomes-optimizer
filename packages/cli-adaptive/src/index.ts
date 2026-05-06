export { withAdaptiveAliases } from './adapters/commander.js';
export { withAdaptiveAliasesYargs } from './adapters/yargs.js';
export { withAdaptiveAliasesOclif } from './adapters/oclif.js';
export { AliasStore } from './alias-store.js';
export { FileTraceAdapter } from './trace.js';
export type {
  TraceAdapter,
  AdaptiveOptions,
  AliasEntry,
  AttemptRecord,
  MatchResult,
} from './types.js';
