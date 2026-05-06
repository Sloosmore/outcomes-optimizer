/**
 * Simple CLI argument parser for --key value pairs.
 *
 * Usage:
 *   const args = parseArgs(process.argv.slice(2))
 *   console.log(args['training-set']) // value after --training-set
 */
export function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        result[key] = value
        i++
      } else {
        // Flag without value (e.g., --verbose)
        result[key] = 'true'
      }
    }
  }
  return result
}
