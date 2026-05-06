# duoidal-cli/scripts

Build scripts for packaging the duoidal CLI. `bundle-skills.js` reads `skills.manifest.json` to determine which skills to copy — currently `skills/create-skill/`, `skills/oversight/`, and `skills/dispatch/` — from repo root into `bundled-skills/` and `dist/bundled-skills/` as a postbuild step.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
