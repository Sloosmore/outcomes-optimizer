# Utils Loop

The epoch-based optimization loop engine. `executeLoop(config)` runs up to `maxEpochs` sessions, each calling `run()` and checking `workspace/progress.md` for a `COMPLETE` signal. State is persisted in `workspace/state.json` for resumability. The loop emits lifecycle events, manages a watchdog, and commits workspace state to git after each epoch.

Key behaviors:
- Resumes from `state.json` if present (`startEpoch = state.epoch + 1`)
- Detects thrashing (3 consecutive epochs with no `state.json` change) and aborts
- Calls `patchProcess()` to update `progress` and `status` in the DB (best-effort, never throws)
- Checks `checkWaitingStatus()` before and after each epoch — exits cleanly if the process entered `waiting` state
- Emits `PROCESS_START`, `EPOCH_END`, `PROCESS_END`, `PROCESS_SLEEP` events
- Starts a watchdog that emits `PROCESS_STALE` after 15 minutes of silence
- Returns `epochLimitReached: true` and exits 0 when `maxEpochs` is exhausted without a COMPLETE signal — this is a budget boundary, not a failure; only thrashing, auth failures, and `run()` errors exit 1 and mark the process `failed`
- Returns `timeLimit: true` and exits 0 when the wall-clock time limit (`MAX_LOOP_DURATION_MS`) is reached — distinct from `epochLimitReached` (budget exhaustion) and never maps to a process failure

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
