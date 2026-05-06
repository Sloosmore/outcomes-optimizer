/**
 * Deployment script — build and push a preview or production deployment.
 *
 * Usage (via npm scripts):
 *   npm run deploy:preview   # Vercel preview URL, never touches production
 *   npm run deploy:live      # promotes to production domain
 *
 * Outputs the deployment URL to stdout (last line), so callers can capture it:
 *   DEPLOY_URL=$(npm run deploy)
 *
 * To add a new provider, implement DeploymentProvider and swap it in below.
 */

import { execSync } from 'child_process'

interface DeploymentProvider {
  deploy(opts: { prod: boolean }): Promise<string>
}

class VercelProvider implements DeploymentProvider {
  async deploy({ prod }: { prod: boolean }): Promise<string> {
    const token = process.env['VERCEL_TOKEN']
    if (!token) throw new Error('VERCEL_TOKEN is not set')

    const flags = ['--yes', `--token ${token}`, prod ? '--prod' : ''].filter(Boolean).join(' ')
    // stderr goes to the terminal for build progress; stdout is captured for the URL
    const output = execSync(`npx vercel deploy ${flags}`, {
      // Run from monorepo root so Vercel uses the top-level .git and resolves
      // the project's rootDirectory (services/agent-livestream) without doubling.
      // services/agent-livestream has a nested .git which confuses Vercel when
      // used as cwd — it treats it as the git root and appends rootDirectory again.
      cwd: new URL('../../../../../', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    })
    const url = output.trim().split('\n').at(-1) ?? ''
    if (!url.startsWith('https://')) throw new Error(`Unexpected deploy output: ${output}`)
    return url
  }
}

async function main() {
  const prod = process.argv.includes('--prod')
  const provider: DeploymentProvider = new VercelProvider()
  const url = await provider.deploy({ prod })
  console.log(url)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
