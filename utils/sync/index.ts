import { resolve } from 'path'
import { join } from 'path'
import { homedir } from 'os'
import { getCLITarget } from '../cli/index.js'
import { copySkillDirectory, listSkillNames } from './copy.js'
import type { SyncResult, SyncOptions } from './types.js'

export function syncSkills(options?: Partial<SyncOptions>): SyncResult[] {
  const target = getCLITarget()
  const defaultSkillsRoot = resolve(process.cwd(), 'skills')
  const skillsRoot = options?.skillsRoot ?? defaultSkillsRoot
  const targetDir = options?.targetDir ?? target.skillsDir
  const userSkillsRoot = options?.userSkillsRoot ?? join(homedir(), '.config', 'duoidal', 'skills')

  const results: SyncResult[] = []

  // Get repo skill names (authoritative)
  const repoSkillNames = new Set(listSkillNames(skillsRoot))

  // Get user skill names
  const userSkillNames = listSkillNames(userSkillsRoot)

  // Copy user-only skills first (repo wins on collision — repo skills are processed second and overwrite)
  for (const skillName of userSkillNames) {
    if (!repoSkillNames.has(skillName)) {
      // User-only skill: copy from user dir
      const result = copySkillDirectory({
        skillName,
        skillsRoot: userSkillsRoot,
        targetDir,
      })
      results.push(result)
    }
    // If in both: skip user version, repo version will be copied below
  }

  // Copy repo skills (repo wins on collision)
  for (const skillName of repoSkillNames) {
    const result = copySkillDirectory({
      skillName,
      skillsRoot,
      targetDir,
    })
    results.push(result)
  }

  return results
}

export { listSkillNames } from './copy.js'
export type { SyncResult, SyncOptions } from './types.js'
