import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import type { SyncResult } from './types.js'
import { SKILL_MARKER_FILE } from '../types.js'

interface CopyInput {
  skillName: string
  skillsRoot: string
  targetDir: string
}

export function copySkillDirectory(input: CopyInput): SyncResult {
  const { skillName, skillsRoot, targetDir } = input
  const resolvedRoot = resolve(skillsRoot)
  const resolvedTarget = resolve(targetDir)
  const sourcePath = resolve(resolvedRoot, skillName)
  const targetPath = resolve(resolvedTarget, skillName)

  // Guard against path traversal: resolved paths must stay within their roots
  if (!sourcePath.startsWith(resolvedRoot + '/') && sourcePath !== resolvedRoot) {
    return {
      skillName,
      sourcePath,
      targetPath,
      success: false,
      error: `Path traversal detected for skill: ${skillName}`,
    }
  }
  if (!targetPath.startsWith(resolvedTarget + '/') && targetPath !== resolvedTarget) {
    return {
      skillName,
      sourcePath,
      targetPath,
      success: false,
      error: `Path traversal detected for skill: ${skillName}`,
    }
  }

  if (!existsSync(sourcePath)) {
    return {
      skillName,
      sourcePath,
      targetPath,
      success: false,
      error: `Source skill not found: ${sourcePath}`,
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true })
    // Overwrite if exists - skills may have been updated
    if (existsSync(targetPath)) {
      cpSync(sourcePath, targetPath, { recursive: true, force: true })
    } else {
      cpSync(sourcePath, targetPath, { recursive: true })
    }

    return {
      skillName,
      sourcePath,
      targetPath,
      success: true,
    }
  } catch (err) {
    return {
      skillName,
      sourcePath,
      targetPath,
      success: false,
      error: (err as Error).message,
    }
  }
}

export function listSkillNames(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) {
    return []
  }

  const entries = readdirSync(skillsRoot)
  return entries.filter(entry => {
    const fullPath = join(skillsRoot, entry)
    return statSync(fullPath).isDirectory() && existsSync(join(fullPath, SKILL_MARKER_FILE))
  })
}
