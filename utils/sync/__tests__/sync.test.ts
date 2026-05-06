import { copySkillDirectory, listSkillNames } from '../copy.js'
import { syncSkills } from '../index.js'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('copySkillDirectory', () => {
  const testDir = join(tmpdir(), 'skill-networks-sync-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('copies skill directory to target', () => {
    const skillsRoot = join(testDir, 'skills')
    const targetDir = join(testDir, 'target')
    mkdirSync(join(skillsRoot, 'my-skill'), { recursive: true })
    writeFileSync(join(skillsRoot, 'my-skill', 'SKILL.md'), '# My Skill')

    const result = copySkillDirectory({
      skillName: 'my-skill',
      skillsRoot,
      targetDir,
    })

    expect(result.success).toBe(true)
    expect(result.skillName).toBe('my-skill')
    expect(existsSync(join(targetDir, 'my-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(targetDir, 'my-skill', 'SKILL.md'), 'utf-8')).toBe('# My Skill')
  })

  it('copies nested files and directories', () => {
    const skillsRoot = join(testDir, 'skills')
    const targetDir = join(testDir, 'target')
    mkdirSync(join(skillsRoot, 'complex-skill', 'scripts'), { recursive: true })
    writeFileSync(join(skillsRoot, 'complex-skill', 'SKILL.md'), '# Complex')
    writeFileSync(join(skillsRoot, 'complex-skill', 'scripts', 'run.sh'), '#!/bin/bash')

    const result = copySkillDirectory({
      skillName: 'complex-skill',
      skillsRoot,
      targetDir,
    })

    expect(result.success).toBe(true)
    expect(existsSync(join(targetDir, 'complex-skill', 'scripts', 'run.sh'))).toBe(true)
  })

  it('returns error for missing source', () => {
    const result = copySkillDirectory({
      skillName: 'nonexistent',
      skillsRoot: join(testDir, 'skills'),
      targetDir: join(testDir, 'target'),
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('creates target directory if needed', () => {
    const skillsRoot = join(testDir, 'skills')
    const targetDir = join(testDir, 'deep', 'nested', 'target')
    mkdirSync(join(skillsRoot, 'my-skill'), { recursive: true })
    writeFileSync(join(skillsRoot, 'my-skill', 'SKILL.md'), '# Test')

    const result = copySkillDirectory({
      skillName: 'my-skill',
      skillsRoot,
      targetDir,
    })

    expect(result.success).toBe(true)
    expect(existsSync(join(targetDir, 'my-skill', 'SKILL.md'))).toBe(true)
  })

  it('overwrites existing skill in target', () => {
    const skillsRoot = join(testDir, 'skills')
    const targetDir = join(testDir, 'target')

    // Create source skill
    mkdirSync(join(skillsRoot, 'my-skill'), { recursive: true })
    writeFileSync(join(skillsRoot, 'my-skill', 'SKILL.md'), '# New Version')

    // Create existing skill in target
    mkdirSync(join(targetDir, 'my-skill'), { recursive: true })
    writeFileSync(join(targetDir, 'my-skill', 'SKILL.md'), '# Old Version')

    const result = copySkillDirectory({
      skillName: 'my-skill',
      skillsRoot,
      targetDir,
    })

    expect(result.success).toBe(true)
    expect(readFileSync(join(targetDir, 'my-skill', 'SKILL.md'), 'utf-8')).toBe('# New Version')
  })
})

describe('listSkillNames', () => {
  const testDir = join(tmpdir(), 'skill-networks-list-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns skill directories with SKILL.md', () => {
    mkdirSync(join(testDir, 'skill-a'), { recursive: true })
    mkdirSync(join(testDir, 'skill-b'), { recursive: true })
    mkdirSync(join(testDir, 'not-a-skill'), { recursive: true })
    writeFileSync(join(testDir, 'skill-a', 'SKILL.md'), '# A')
    writeFileSync(join(testDir, 'skill-b', 'SKILL.md'), '# B')

    const names = listSkillNames(testDir)

    expect(names).toContain('skill-a')
    expect(names).toContain('skill-b')
    expect(names).not.toContain('not-a-skill')
  })

  it('returns empty array for missing directory', () => {
    const names = listSkillNames(join(testDir, 'nonexistent'))

    expect(names).toEqual([])
  })

  it('ignores files (not directories)', () => {
    writeFileSync(join(testDir, 'file.txt'), 'not a skill')
    mkdirSync(join(testDir, 'real-skill'), { recursive: true })
    writeFileSync(join(testDir, 'real-skill', 'SKILL.md'), '# Real')

    const names = listSkillNames(testDir)

    expect(names).toEqual(['real-skill'])
  })
})

describe('syncSkills', () => {
  const testDir = join(tmpdir(), 'skill-networks-sync-skills-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('dual-source merge: both repo and user skills appear in target', () => {
    const repoDir = join(testDir, 'repo-skills')
    const userDir = join(testDir, '0a9b5646-fbfa-455c-820b-946382437807')
    const targetDir = join(testDir, 'target')

    // repo skill
    mkdirSync(join(repoDir, 'repo-skill'), { recursive: true })
    writeFileSync(join(repoDir, 'repo-skill', 'SKILL.md'), '# Repo Skill')

    // user skill (different name)
    mkdirSync(join(userDir, 'fd6c0001-4682-48d6-87c9-4b3fb2da1539'), { recursive: true })
    writeFileSync(join(userDir, 'fd6c0001-4682-48d6-87c9-4b3fb2da1539', 'SKILL.md'), '# User Skill')

    const results = syncSkills({ skillsRoot: repoDir, userSkillsRoot: userDir, targetDir })

    expect(results.length).toBe(2)
    expect(existsSync(join(targetDir, 'repo-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(targetDir, 'repo-skill', 'SKILL.md'), 'utf-8')).toBe('# Repo Skill')
    expect(existsSync(join(targetDir, 'fd6c0001-4682-48d6-87c9-4b3fb2da1539', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(targetDir, 'fd6c0001-4682-48d6-87c9-4b3fb2da1539', 'SKILL.md'), 'utf-8')).toBe('# User Skill')
  })

  it('collision resolution: repo wins when same skill name exists in both', () => {
    const repoDir = join(testDir, 'repo-skills')
    const userDir = join(testDir, '0a9b5646-fbfa-455c-820b-946382437807')
    const targetDir = join(testDir, 'target')

    // same skill name in both
    mkdirSync(join(repoDir, 'shared-skill'), { recursive: true })
    writeFileSync(join(repoDir, 'shared-skill', 'SKILL.md'), '# Repo Version')

    mkdirSync(join(userDir, 'shared-skill'), { recursive: true })
    writeFileSync(join(userDir, 'shared-skill', 'SKILL.md'), '# User Version')

    const results = syncSkills({ skillsRoot: repoDir, userSkillsRoot: userDir, targetDir })

    expect(existsSync(join(targetDir, 'shared-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(targetDir, 'shared-skill', 'SKILL.md'), 'utf-8')).toBe('# Repo Version')
    // only one result (repo skill wins, user version is not copied)
    const skillResults = results.filter(r => r.skillName === 'shared-skill')
    expect(skillResults.length).toBe(1)
  })

  it('SyncResult.sourcePath tracking: user-only skill points to user dir', () => {
    const repoDir = join(testDir, 'repo-skills')
    const userDir = join(testDir, '0a9b5646-fbfa-455c-820b-946382437807')
    const targetDir = join(testDir, 'target')

    // Only a user skill (not in repo)
    mkdirSync(join(userDir, '12f61bbd-1ba2-44fe-83ca-d0e44903d0a2'), { recursive: true })
    writeFileSync(join(userDir, '12f61bbd-1ba2-44fe-83ca-d0e44903d0a2', 'SKILL.md'), '# User Only')

    const results = syncSkills({ skillsRoot: repoDir, userSkillsRoot: userDir, targetDir })

    const userResult = results.find(r => r.skillName === '12f61bbd-1ba2-44fe-83ca-d0e44903d0a2')
    expect(userResult).toBeDefined()
    expect(userResult!.success).toBe(true)
    expect(userResult!.sourcePath).toBe(join(userDir, '12f61bbd-1ba2-44fe-83ca-d0e44903d0a2'))
  })

  it('zero-arg backward compat: works without arguments and does not crash', () => {
    // Just verify calling syncSkills() with no args doesn't throw
    expect(() => syncSkills()).not.toThrow()
  })

  it('missing user dir: does not crash and still syncs repo skills', () => {
    const repoDir = join(testDir, 'repo-skills')
    const targetDir = join(testDir, 'target')

    mkdirSync(join(repoDir, 'repo-skill'), { recursive: true })
    writeFileSync(join(repoDir, 'repo-skill', 'SKILL.md'), '# Repo Skill')

    const results = syncSkills({
      skillsRoot: repoDir,
      userSkillsRoot: '/nonexistent/path/xyz',
      targetDir,
    })

    expect(results.length).toBe(1)
    expect(results[0].skillName).toBe('repo-skill')
    expect(results[0].success).toBe(true)
    expect(existsSync(join(targetDir, 'repo-skill', 'SKILL.md'))).toBe(true)
  })
})
