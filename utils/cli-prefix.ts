/**
 * Resolves the CLI binary and prefix args from the SKILL_NETWORKS_CLI env var.
 *
 * Default: 'pnpm exec duoidal'
 *
 * Examples:
 *   SKILL_NETWORKS_CLI="pnpm exec duoidal"  → getCliCommand() returns ['pnpm', ['exec', 'duoidal']]
 *   SKILL_NETWORKS_CLI="npx duoidal"         → getCliCommand() returns ['npx', ['duoidal']]
 *   SKILL_NETWORKS_CLI="pnpm exec agent-core" → backward compat
 */

const DEFAULT_CLI = 'pnpm exec duoidal'

/**
 * Returns [bin, prefixArgs] for use with execFileSync/execFile.
 *
 * Usage: const [bin, prefixArgs] = getCliCommand()
 *        execFileSync(bin, [...prefixArgs, 'process', 'init', '--name', name], opts)
 *
 * Note: The value is split on spaces. Binary paths containing spaces are not supported.
 */
export function getCliCommand(): [string, string[]] {
  const cli = process.env['SKILL_NETWORKS_CLI'] ?? DEFAULT_CLI
  const parts = cli.split(' ')
  return [parts[0]!, parts.slice(1)]
}

/**
 * Returns the full CLI prefix string for bash heredoc interpolation.
 *
 * Usage: `${getCliBashPrefix()} process status --id "$EVAL_PROCESS_ID" --json`
 */
export function getCliBashPrefix(): string {
  return process.env['SKILL_NETWORKS_CLI'] ?? DEFAULT_CLI
}
