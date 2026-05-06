#!/usr/bin/env node
/**
 * Copies distributable skills (from skills.manifest.json) from the repo root
 * into packages/duoidal-cli/bundled-skills/, then into dist/bundled-skills/.
 *
 * Run as part of the build (postbuild).
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'skills.manifest.json'), 'utf8'))
const SKILLS = manifest.distributable
const bundledDir = join(pkgRoot, 'bundled-skills')
const distBundledDir = join(pkgRoot, 'dist', 'bundled-skills')

// Clean and recreate
for (const dir of [bundledDir, distBundledDir]) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

for (const skill of SKILLS) {
  const src = join(pkgRoot, manifest.skillsDir, skill)
  cpSync(src, join(bundledDir, skill), { recursive: true })
  cpSync(src, join(distBundledDir, skill), { recursive: true })
}

// Copy manifest into dist/ so the runtime require('./skills.manifest.json')
// resolves correctly when the package is installed (files: ["dist"] only).
copyFileSync(join(pkgRoot, 'skills.manifest.json'), join(pkgRoot, 'dist', 'skills.manifest.json'))

console.log(`Bundled ${SKILLS.length} skills into bundled-skills/ and dist/bundled-skills/`)
