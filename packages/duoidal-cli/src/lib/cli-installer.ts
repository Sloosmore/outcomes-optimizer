import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import type { StoredToken } from './config.js'

export interface CliInstallerOptions {
  // for NpmCliInstaller
  version?: string
  // for LocalCliInstaller
  cliPkgDir?: string
}

export interface CliInstaller {
  install(ip: string, keyPath: string, sshOpts: string[], options: CliInstallerOptions, token?: StoredToken): Promise<void>
}

/**
 * NpmCliInstaller — installs @duoidal/cli from the npm registry on a remote VM via SSH.
 * Runs: npm install -g @duoidal/cli@<version>
 */
export class NpmCliInstaller implements CliInstaller {
  async install(ip: string, _keyPath: string, sshOpts: string[], options: CliInstallerOptions, token?: StoredToken): Promise<void> {
    const version = options.version
    if (!version) {
      throw new Error('NpmCliInstaller requires options.version to be set')
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
      throw new Error(`NpmCliInstaller: invalid version format: "${version}"`)
    }
    execFileSync('ssh', [...sshOpts, `root@${ip}`, `npm install -g @duoidal/cli@${version}`], { stdio: 'inherit' })
    if (token) {
      execFileSync(
        'ssh',
        [...sshOpts, `root@${ip}`, 'mkdir -p ~/.config/duoidal && cat > ~/.config/duoidal/token.json && chmod 0600 ~/.config/duoidal/token.json'],
        { input: JSON.stringify(token), stdio: ['pipe', 'inherit', 'inherit'] }
      )
    }
    execFileSync('ssh', [...sshOpts, `root@${ip}`, 'duoidal init'], { stdio: 'inherit' })
  }
}

/**
 * LocalCliInstaller — installs @duoidal/cli by SCPing the local dist/ and package.json to
 * the remote VM and running npm install + npm link.
 *
 * This is the original inline logic extracted from the provision command.
 */
export class LocalCliInstaller implements CliInstaller {
  async install(ip: string, _keyPath: string, sshOpts: string[], options: CliInstallerOptions, token?: StoredToken): Promise<void> {
    const cliPkgDir = options.cliPkgDir
    if (!cliPkgDir) {
      throw new Error('LocalCliInstaller requires options.cliPkgDir to be set')
    }

    // Create deploy-ready package.json: strip workspace:* devDependencies and workspace:* dependencies
    // (workspace deps are bundled into dist/index.js by tsup and don't need to be npm-installed)
    const localPkg = JSON.parse(fs.readFileSync(path.join(cliPkgDir, 'package.json'), 'utf-8')) as Record<string, unknown>
    const deployPkg: Record<string, unknown> = { ...localPkg }
    delete deployPkg['devDependencies']
    if (deployPkg['dependencies'] && typeof deployPkg['dependencies'] === 'object') {
      const deps = deployPkg['dependencies'] as Record<string, string>
      const filteredDeps = Object.fromEntries(
        Object.entries(deps).filter(([, v]) => !v.startsWith('workspace:'))
      )
      deployPkg['dependencies'] = filteredDeps
    }
    const deployTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-cli-deploy-'))
    const deployPkgPath = path.join(deployTmpDir, 'package.json')
    fs.writeFileSync(deployPkgPath, JSON.stringify(deployPkg, null, 2))

    // Create remote dir and copy CLI files
    execFileSync('ssh', [...sshOpts, `root@${ip}`, 'mkdir -p /root/duoidal-cli'])
    execFileSync('scp', ['-r', ...sshOpts, path.join(cliPkgDir, 'dist'), `root@${ip}:/root/duoidal-cli/`])
    execFileSync('scp', [...sshOpts, deployPkgPath, `root@${ip}:/root/duoidal-cli/package.json`])
    // npm install (prod deps only) + npm link to put `duoidal` on PATH
    execFileSync('ssh', [...sshOpts, `root@${ip}`, 'cd /root/duoidal-cli && npm install --omit=dev && npm link'])
    if (token) {
      execFileSync(
        'ssh',
        [...sshOpts, `root@${ip}`, 'mkdir -p ~/.config/duoidal && cat > ~/.config/duoidal/token.json && chmod 0600 ~/.config/duoidal/token.json'],
        { input: JSON.stringify(token), stdio: ['pipe', 'inherit', 'inherit'] }
      )
    }
    execFileSync('ssh', [...sshOpts, `root@${ip}`, 'duoidal init'], { stdio: 'inherit' })
  }
}
