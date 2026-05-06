import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { PreflightHook, PreflightContext } from '../../types.js'

/**
 * Preflight hook that writes .claude/settings.json into the working directory
 * so Claude Code picks up blanket permissions. The --settings CLI flag does NOT
 * affect permissionMode and cannot unlock file writes; the JSON file in the
 * project root is what Claude Code actually reads.
 */
export const writeSettingsHook: PreflightHook = {
  name: 'write-claude-settings',
  async run(ctx) {
    const dir = resolve(ctx.workingDir, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'settings.json'),
      JSON.stringify({
        permissions: {
          // Wildcard allow covers all built-in tools, MCP tools, skills,
          // and any future tools without needing to maintain an explicit list.
          // An explicit allowlist regresses tool access when new tools are added.
          allow: ['*'],
          deny: [
            'Bash(rm -rf *)',
            'Bash(git push --force*)',
            'Bash(git push -f *)',
            'Bash(git reset --hard*)',
            'Bash(git clean *)',
            'Bash(gh repo delete*)',
            'Bash(sudo *)',
            'Bash(su *)',
            'Bash(chmod 777*)',
          ],
        },
      }, null, 2)
    )
  },
}

/**
 * Agent definition for the eval agent (Claude Code specific)
 */
const EVAL_AGENT_DEFINITION = `---
name: eval-agent
description: Evaluates skills against rubric criteria. Interprets artifacts and assesses whether criteria are met.
tools: Read, Glob, Grep, WebFetch
model: sonnet
---

You are an evaluation agent that assesses whether skill executions meet their defined criteria.

## Your Role

You receive:
1. **Files** - Artifact files to evaluate (HTTP responses, screenshots, JSON data, etc.)
2. **Checks** - Criteria to evaluate against (natural language descriptions)
3. **Context** - Additional context about the evaluation

## Evaluation Process

For each check:
1. Read the relevant artifact files
2. Interpret the criteria against the file contents
3. Determine if the criteria is met (pass/fail)
4. Provide reasoning for your decision

## Output Format

Write your evaluation results to a JSON file with this structure:

\`\`\`json
{
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1
  },
  "checks": [
    {
      "id": "check-1",
      "criteria": "User account was created successfully",
      "passed": true,
      "reasoning": "The HTTP response shows status 201 Created with user data",
      "artifacts_reviewed": ["response.json"]
    }
  ],
  "overall": "partial",
  "notes": "Optional overall notes about the evaluation"
}
\`\`\`

## Guidelines

- Be objective and consistent
- Base decisions only on artifact contents
- Clearly explain your reasoning
- If an artifact is missing, mark the check as failed with explanation
- For ambiguous criteria, err on the side of stricter interpretation
`

/**
 * Check if the agent definition needs to be updated
 */
function needsUpdate(agentPath: string): boolean {
  if (!existsSync(agentPath)) {
    return true
  }

  try {
    const existing = readFileSync(agentPath, 'utf-8')
    return existing !== EVAL_AGENT_DEFINITION
  } catch {
    return true
  }
}

/**
 * Preflight hook that ensures the eval agent definition exists
 * in .claude/agents/ directory.
 */
export const evalAgentHook: PreflightHook = {
  name: 'claude-code:eval-agent',

  async run(context: PreflightContext): Promise<void> {
    // Only run for claude-code adapter
    if (context.adapter !== 'claude-code') {
      return
    }

    const agentPath = resolve(context.configDir, 'agents', 'eval-agent.md')

    // Check if update needed (idempotency)
    if (!needsUpdate(agentPath)) {
      return
    }

    // Ensure agents directory exists
    const agentsDir = resolve(context.configDir, 'agents')
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true })
    }

    // Write agent definition
    writeFileSync(agentPath, EVAL_AGENT_DEFINITION, 'utf-8')
  },
}
