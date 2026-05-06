import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeSettingsHook } from '../preflight.js'

describe('writeSettingsHook', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'write-settings-hook-test-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates .claude/settings.json in the working directory', async () => {
    await writeSettingsHook.run({ workingDir: testDir } as any)

    const settingsPath = join(testDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
  })

  it('writes valid JSON with expected permissions structure', async () => {
    await writeSettingsHook.run({ workingDir: testDir } as any)

    const settingsPath = join(testDir, '.claude', 'settings.json')
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'))

    expect(content.permissions).toBeDefined()
    expect(content.permissions.allow).toEqual(['*'])
    expect(Array.isArray(content.permissions.deny)).toBe(true)
    expect(content.permissions.deny.length).toBeGreaterThan(0)
  })

  it('deny list blocks dangerous bash commands', async () => {
    await writeSettingsHook.run({ workingDir: testDir } as any)

    const settingsPath = join(testDir, '.claude', 'settings.json')
    const { permissions } = JSON.parse(readFileSync(settingsPath, 'utf-8'))

    expect(permissions.deny).toContain('Bash(rm -rf *)')
    expect(permissions.deny).toContain('Bash(git push --force*)')
    expect(permissions.deny).toContain('Bash(git reset --hard*)')
    expect(permissions.deny).toContain('Bash(sudo *)')
  })

  it('creates the .claude directory if it does not exist', async () => {
    const nested = join(testDir, 'nested')
    await writeSettingsHook.run({ workingDir: nested } as any)

    expect(existsSync(join(nested, '.claude', 'settings.json'))).toBe(true)
  })
})
