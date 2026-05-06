import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { getApiBaseUrl } from './helpers.js'

// Resolve skills.manifest.json from two known locations:
//   1. dist/skills.manifest.json  — when running from compiled dist/index.js
//   2. ../../skills.manifest.json — when running from TypeScript source (src/lib/ → package root)
const _require = createRequire(import.meta.url)
function _findManifest(): { distributable: string[] } {
  const __dir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(__dir, 'skills.manifest.json'),
    path.join(__dir, '..', '..', 'skills.manifest.json'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return _require(p)
  }
  throw new Error(`skills.manifest.json not found (checked: ${candidates.join(', ')})`)
}
export const BUNDLED_SKILL_NAMES: ReadonlyArray<string> = _findManifest().distributable

/**
 * Returns the path to bundled skills in the installed CLI package.
 * In dist: index.js is at dist/index.js, skills are at dist/bundled-skills/
 */
export function getBundledSkillsRoot(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.join(__dirname, 'bundled-skills')
}

export interface WriteSkillsOptions {
  /** Target dir to write skills into. Default: ~/.config/duoidal/skills */
  configSkillsDir?: string
  /** Source of bundled skills. Default: dist/bundled-skills/ relative to this module */
  bundledSkillsRoot?: string
}

/**
 * Writes all distributable bundled skills (from skills.manifest.json) to configSkillsDir.
 * Atomic per-skill: temp dir + rename (with EXDEV fallback for cross-device).
 * Idempotent: second call overwrites with same content.
 */
export function writeSkillsToConfig(options: WriteSkillsOptions = {}): void {
  const configSkillsDir = options.configSkillsDir ?? path.join(os.homedir(), '.config', 'duoidal', 'skills')
  const bundledSkillsRoot = options.bundledSkillsRoot ?? getBundledSkillsRoot()

  fs.mkdirSync(configSkillsDir, { recursive: true })

  for (const skillName of BUNDLED_SKILL_NAMES) {
    const srcDir = path.join(bundledSkillsRoot, skillName)
    if (!fs.existsSync(srcDir)) throw new Error(`Bundled skill directory missing: ${srcDir}`)

    const destDir = path.join(configSkillsDir, skillName)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `duoidal-skill-${skillName}-`))
    try {
      copyDirRecursive(srcDir, tmpDir)
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
      }
      try {
        fs.renameSync(tmpDir, destDir)
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          fs.mkdirSync(destDir, { recursive: true })
          copyDirRecursive(tmpDir, destDir)
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } else {
          throw e
        }
      }
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore cleanup errors */ }
      throw e
    }
  }
}

/**
 * Fetches skills from the BFF (unauthenticated) and writes them to ~/.config/duoidal/skills/.
 * Falls back to bundled skills when the BFF is unreachable or a skill isn't in the bucket yet.
 * Atomic per-skill: temp file + temp dir + rename. Idempotent: second call replaces with fresh content.
 */
export async function fetchAndWriteSkills(options?: { bundledSkillsRoot?: string }): Promise<void> {
  const apiBaseUrl = getApiBaseUrl()
  const configSkillsDir = path.join(os.homedir(), '.config', 'duoidal', 'skills')
  const bundledRoot = options?.bundledSkillsRoot ?? getBundledSkillsRoot()

  fs.mkdirSync(configSkillsDir, { recursive: true })

  let useBundledFallback = false

  for (const skillName of BUNDLED_SKILL_NAMES) {
    if (useBundledFallback) {
      _writeBundledSkill(skillName, configSkillsDir, bundledRoot)
      continue
    }

    const url = `${apiBaseUrl}/api/skills/${skillName}`

    let res: Response
    try {
      res = await fetch(url)
    } catch {
      console.error(`BFF unreachable — falling back to bundled skills`)
      useBundledFallback = true
      _writeBundledSkill(skillName, configSkillsDir, bundledRoot)
      continue
    }

    if (res.status === 404) {
      console.error(`Skill ${skillName} not in bucket — using bundled version`)
      _writeBundledSkill(skillName, configSkillsDir, bundledRoot)
      continue
    }
    if (!res.ok) {
      console.error(`HTTP ${res.status} fetching ${skillName} — using bundled version`)
      _writeBundledSkill(skillName, configSkillsDir, bundledRoot)
      continue
    }

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Write tarball to temp file
    const tmpDir = os.tmpdir()
    const tmpTarFile = path.join(fs.mkdtempSync(path.join(tmpDir, `duoidal-skill-tar-`)), `${skillName}.tar.gz`)
    fs.writeFileSync(tmpTarFile, buffer)

    // Extract to temp dir
    // The archive contains skillName/ as the root, so the extracted content is at tmpExtractDir/skillName/
    const tmpExtractDir = fs.mkdtempSync(path.join(tmpDir, `duoidal-skill-extract-`))
    try {
      execSync(`tar xzf "${tmpTarFile}" -C "${tmpExtractDir}"`)

      const extractedSkillDir = path.join(tmpExtractDir, skillName)
      const destDir = path.join(configSkillsDir, skillName)
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
      }

      try {
        fs.renameSync(extractedSkillDir, destDir)
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          copyDirRecursive(extractedSkillDir, destDir)
          fs.rmSync(tmpExtractDir, { recursive: true, force: true })
        } else {
          throw e
        }
      }
    } catch (e) {
      try { fs.rmSync(tmpExtractDir, { recursive: true, force: true }) } catch { /* ignore cleanup errors */ }
      throw e
    } finally {
      try {
        const tmpTarDir = path.dirname(tmpTarFile)
        fs.rmSync(tmpTarDir, { recursive: true, force: true })
      } catch { /* ignore cleanup errors */ }
    }
  }
}

function _writeBundledSkill(skillName: string, configSkillsDir: string, bundledRoot: string): void {
  const srcDir = path.join(bundledRoot, skillName)
  if (!fs.existsSync(srcDir)) {
    console.error(`Bundled skill ${skillName} not found at ${srcDir} — skipping`)
    return
  }
  const destDir = path.join(configSkillsDir, skillName)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `duoidal-skill-${skillName}-`))
  try {
    copyDirRecursive(srcDir, tmpDir)
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    try {
      fs.renameSync(tmpDir, destDir)
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        fs.mkdirSync(destDir, { recursive: true })
        copyDirRecursive(tmpDir, destDir)
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } else {
        throw e
      }
    }
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw e
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}
