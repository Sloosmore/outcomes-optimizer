# Scheduler Package

The cron poller and wake-scheduler extracted from `services/runtime/`.

## Verification

### Build check
```bash
cd packages/scheduler && npx tsc --noEmit
```

### Unit tests
```bash
cd packages/scheduler && npm test
```

### Import boundary check
```bash
grep -r 'import.*from.*utils/dispatch' packages/scheduler/src/
```
Should show only `validateSkillConfig` and `dispatchRun` from `poller.ts`.

```bash
grep -r 'import.*from.*utils/cli' packages/scheduler/src/
```
Should return nothing.

### No stale references
```bash
grep -rn 'services/runtime/src' packages/ utils/ services/ --include='*.ts' --include='*.js'
```
Should return 0 matches.
