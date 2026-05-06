/**
 * Branch name utilities for dispatch workflows.
 *
 * Provides slug generation and branch name construction.
 */

import { fileURLToPath } from 'url'

/**
 * Converts text to a URL-safe slug.
 * Lowercases, replaces non-alphanumeric chars with hyphens,
 * collapses consecutive hyphens, trims to 30 chars, and strips
 * leading/trailing hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 30)
    .replace(/^-+|-+$/g, '')
}

/**
 * Constructs a branch name from a prefix and slug.
 * e.g. branchName("feat", "my-feature") => "feat/my-feature"
 */
export function branchName(prefix: string, slug: string): string {
  return `${prefix}/${slug}`
}

function main(): void {
  const args = process.argv.slice(2)
  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        parsed[key] = value
        i++
      }
    }
  }

  if (parsed['slug'] && parsed['prefix']) {
    const slug = slugify(parsed['slug'])
    console.log(branchName(parsed['prefix'], slug))
  } else if (parsed['slug']) {
    console.log(slugify(parsed['slug']))
  } else {
    console.error('Usage: slug.ts --slug <text> [--prefix <prefix>]')
    process.exit(1)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
