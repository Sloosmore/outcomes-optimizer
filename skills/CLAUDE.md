# skills/

Version-controlled capabilities that evolve via execution experience.

## Portability

Skills should be abstract and portable across codebases. Avoid hardcoding:
- Package names, CLI tool names, or infrastructure references specific to one repo
- IP addresses, SSH keys, or cloud provider details
- Environment variable names specific to one deployment
- File paths that only exist in one project

When illustrative examples are needed, use generic placeholders (`packages/example-package/`, `npx <graph-cli>`, `flow/example-flow`). The executing agent resolves these to real names by reading the codebase's CLAUDE.md and running discovery commands.

Tier 3 references (structural dependencies on specific CLI tools like `npx duoidal traverse` in create-skill's flow enumeration) are known and accepted for now — they require the graph infrastructure to function. These will be abstracted when the skill installation system supports adapter configuration.
