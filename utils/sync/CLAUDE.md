# Utils Sync

Skill syncing: copies skill directories from `skills/` into the CLI adapter's target directory (e.g., `.claude/skills/` for claude-code, `.agents/skills/` for codex).

`syncSkills(options?)` — lists all skill directories under `skillsRoot` (defaults to `./skills/`), copies each to `targetDir` (defaults to `target.skillsDir` from the CLI adapter), and returns an array of `SyncResult` objects with `success`, `skillName`, and `error`.

`listSkillNames(skillsRoot)` — returns directory names under `skillsRoot` that are valid skill directories.

`copySkillDirectory` — copies a single skill directory recursively.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
