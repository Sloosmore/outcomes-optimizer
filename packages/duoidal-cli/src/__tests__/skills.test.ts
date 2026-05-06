import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── Stable mock paths ──────────────────────────────────────────────────────
const TEST_CONFIG_DIR = path.join(os.tmpdir(), `duoidal-skills-test-${process.pid}`)
const TEST_SKILLS_JSON = path.join(TEST_CONFIG_DIR, 'skills.json')
const TEST_SKILLS_DIR = path.join(TEST_CONFIG_DIR, 'skills')

vi.mock('../lib/config.js', () => ({
  CONFIG_DIR: TEST_CONFIG_DIR,
  TOKEN_PATH: path.join(TEST_CONFIG_DIR, 'token.json'),
  SKILLS_JSON_PATH: path.join(TEST_CONFIG_DIR, 'skills.json'),
  SKILLS_DIR: path.join(TEST_CONFIG_DIR, 'skills'),
  readToken: vi.fn(),
  writeToken: vi.fn(),
  getSandboxKeyDir: vi.fn(),
  getSandboxKeyPath: vi.fn(),
  writeSandboxKey: vi.fn(),
  getActorId: vi.fn(),
}))

// ── GitHub API mock helpers ───────────────────────────────────────────────

function makeFileResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name: 'SKILL.md',
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    }),
    text: async () => content,
  }
}

function makeDirectoryResponse(files: Array<{ name: string; download_url: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () =>
      files.map(f => ({ name: f.name, type: 'file', download_url: f.download_url })),
    text: async () => JSON.stringify(files),
  }
}

function makeRawFileResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error('not json') },
    text: async () => content,
  }
}

function makeNotFoundResponse() {
  return {
    ok: false,
    status: 404,
    json: async () => ({ message: 'Not Found' }),
    text: async () => 'Not Found',
  }
}

// ── Test setup ────────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ── Import command under test ────────────────────────────────────────────

async function loadSkillsCommand() {
  const mod = await import('../commands/skills.js')
  return mod
}

// Helper: run a commander command programmatically
async function runCommand(args: string[]) {
  const { skillsCommand } = await loadSkillsCommand()
  const cmd = skillsCommand()
  // Prevent commander from calling process.exit on error
  cmd.exitOverride()
  await cmd.parseAsync(['node', 'duoidal', ...args])
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('skills add', () => {
  it('fetches SKILL.md and references/, writes skill files, updates skills.json', async () => {
    const skillContent = '# Throwmail\n\nA skill for sending emails.'
    const ref1Content = 'Reference 1 content'
    const ref2Content = 'Reference 2 content'

    mockFetch
      // First call: SKILL.md contents API
      .mockResolvedValueOnce(makeFileResponse(skillContent))
      // Second call: references/ directory listing
      .mockResolvedValueOnce(makeDirectoryResponse([
        { name: 'guide.md', download_url: 'https://raw.githubusercontent.com/test-owner/test-skill/main/references/guide.md' },
        { name: 'api.md', download_url: 'https://raw.githubusercontent.com/test-owner/test-skill/main/references/api.md' },
      ]))
      // Third call: guide.md raw content
      .mockResolvedValueOnce(makeRawFileResponse(ref1Content))
      // Fourth call: api.md raw content
      .mockResolvedValueOnce(makeRawFileResponse(ref2Content))

    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['add', 'test-owner/test-skill'])

    mockConsoleLog.mockRestore()

    // SKILL.md written
    const skillMdPath = path.join(TEST_SKILLS_DIR, 'throwmail', 'SKILL.md')
    expect(fs.existsSync(skillMdPath)).toBe(true)
    expect(fs.readFileSync(skillMdPath, 'utf-8')).toBe(skillContent)

    // references written
    const ref1Path = path.join(TEST_SKILLS_DIR, 'throwmail', 'references', 'guide.md')
    const ref2Path = path.join(TEST_SKILLS_DIR, 'throwmail', 'references', 'api.md')
    expect(fs.existsSync(ref1Path)).toBe(true)
    expect(fs.readFileSync(ref1Path, 'utf-8')).toBe(ref1Content)
    expect(fs.existsSync(ref2Path)).toBe(true)
    expect(fs.readFileSync(ref2Path, 'utf-8')).toBe(ref2Content)

    // skills.json updated
    expect(fs.existsSync(TEST_SKILLS_JSON)).toBe(true)
    const registry = JSON.parse(fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')) as {
      skills: Array<{ name: string; source: string; installedAt: string }>
    }
    expect(registry.skills).toHaveLength(1)
    expect(registry.skills[0]!.name).toBe('throwmail')
    expect(registry.skills[0]!.source).toBe('https://github.com/test-owner/test-skill')
    expect(registry.skills[0]!.installedAt).toBeTruthy()

    // skills.json has 0o600 permissions
    const stat = fs.statSync(TEST_SKILLS_JSON)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('uses correct GitHub API URL for SKILL.md', async () => {
    const skillContent = '# Test Skill'

    mockFetch
      .mockResolvedValueOnce(makeFileResponse(skillContent))
      .mockResolvedValueOnce(makeDirectoryResponse([]))

    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCommand(['add', 'test-owner/test-skill'])
    mockConsoleLog.mockRestore()

    const firstCall = mockFetch.mock.calls[0]!
    expect(firstCall[0]).toBe('https://api.github.com/repos/test-owner/test-skill/contents/SKILL.md')
    const secondCall = mockFetch.mock.calls[1]!
    expect(secondCall[0]).toBe('https://api.github.com/repos/test-owner/test-skill/contents/references')
  })

  it('is idempotent — running add twice produces same result, no duplicate in skills.json', async () => {
    const skillContent = '# Throwmail'

    const makeMocks = () => [
      makeFileResponse(skillContent),
      makeDirectoryResponse([
        { name: 'guide.md', download_url: 'https://raw.githubusercontent.com/test-owner/test-skill/main/references/guide.md' },
      ]),
      makeRawFileResponse('guide content'),
    ]

    mockFetch
      .mockResolvedValueOnce(makeMocks()[0]!)
      .mockResolvedValueOnce(makeMocks()[1]!)
      .mockResolvedValueOnce(makeMocks()[2]!)
      // Second run
      .mockResolvedValueOnce(makeMocks()[0]!)
      .mockResolvedValueOnce(makeMocks()[1]!)
      .mockResolvedValueOnce(makeMocks()[2]!)

    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['add', 'test-owner/test-skill'])
    await runCommand(['add', 'test-owner/test-skill'])

    mockConsoleLog.mockRestore()

    const registry = JSON.parse(fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')) as {
      skills: Array<{ name: string; source: string; installedAt: string }>
    }
    expect(registry.skills).toHaveLength(1)
    expect(registry.skills[0]!.name).toBe('throwmail')
  })

  it('handles missing references/ directory gracefully (no references fetched)', async () => {
    const skillContent = '# Throwmail'

    mockFetch
      // SKILL.md
      .mockResolvedValueOnce(makeFileResponse(skillContent))
      // references/ returns 404 (no references dir)
      .mockResolvedValueOnce(makeNotFoundResponse())

    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCommand(['add', 'test-owner/test-skill'])
    mockConsoleLog.mockRestore()

    // SKILL.md written
    const skillMdPath = path.join(TEST_SKILLS_DIR, 'throwmail', 'SKILL.md')
    expect(fs.existsSync(skillMdPath)).toBe(true)

    // No references dir
    const refsDir = path.join(TEST_SKILLS_DIR, 'throwmail', 'references')
    expect(fs.existsSync(refsDir)).toBe(false)

    // skills.json updated
    const registry = JSON.parse(fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')) as {
      skills: Array<{ name: string }>
    }
    expect(registry.skills).toHaveLength(1)
  })

  describe('GitHub 404 error handling', () => {
    it('exits non-zero when SKILL.md returns 404', async () => {
      mockFetch.mockResolvedValueOnce(makeNotFoundResponse())

      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(runCommand(['add', 'test-owner/nonexistent'])).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('does NOT write to disk when SKILL.md fetch fails', async () => {
      mockFetch.mockResolvedValueOnce(makeNotFoundResponse())

      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(runCommand(['add', 'test-owner/nonexistent'])).rejects.toThrow()

      // No skill directory written
      const skillDir = path.join(TEST_SKILLS_DIR, 'nonexistent')
      expect(fs.existsSync(skillDir)).toBe(false)

      // skills.json not created
      expect(fs.existsSync(TEST_SKILLS_JSON)).toBe(false)

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('does NOT update skills.json when SKILL.md fetch fails', async () => {
      // Pre-create a skills.json with one skill
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      const existingRegistry = {
        skills: [{ name: 'existing', source: 'https://github.com/x/existing', installedAt: '2026-01-01T00:00:00.000Z' }],
      }
      fs.writeFileSync(TEST_SKILLS_JSON, JSON.stringify(existingRegistry), { mode: 0o600 })

      mockFetch.mockResolvedValueOnce(makeNotFoundResponse())

      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(runCommand(['add', 'test-owner/nonexistent'])).rejects.toThrow()

      // skills.json unchanged
      const registry = JSON.parse(fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')) as {
        skills: Array<{ name: string }>
      }
      expect(registry.skills).toHaveLength(1)
      expect(registry.skills[0]!.name).toBe('existing')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })
  })

  describe('atomic write verification', () => {
    it('skills.json is NOT partially updated when write is interrupted', async () => {
      // Pre-create a skills.json
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      const existingRegistry = {
        skills: [{ name: 'existing', source: 'https://github.com/x/existing', installedAt: '2026-01-01T00:00:00.000Z' }],
      }
      fs.writeFileSync(TEST_SKILLS_JSON, JSON.stringify(existingRegistry), { mode: 0o600 })
      const originalContent = fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')

      // Mock renameSync to throw on the skills.json tmp rename
      const originalRename = fs.renameSync.bind(fs)
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (String(dest) === TEST_SKILLS_JSON) {
          throw new Error('Simulated write failure')
        }
        return originalRename(src as string, dest as string)
      })

      const skillContent = '# Throwmail'
      mockFetch
        .mockResolvedValueOnce(makeFileResponse(skillContent))
        .mockResolvedValueOnce(makeDirectoryResponse([]))

      const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)

      await expect(runCommand(['add', 'test-owner/test-skill'])).rejects.toThrow()

      // skills.json content must be unchanged (not partially written)
      const currentContent = fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')
      expect(currentContent).toBe(originalContent)

      renameSpy.mockRestore()
      mockConsoleLog.mockRestore()
      mockConsoleError.mockRestore()
      mockExit.mockRestore()
    })
  })
})

describe('skills list', () => {
  it('prints installed skills from skills.json with name + source', async () => {
    // Create skills.json with two skills
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    const registry = {
      skills: [
        { name: 'throwmail', source: 'https://github.com/test-owner/test-skill', installedAt: '2026-04-06T00:00:00.000Z' },
        { name: 'otherskill', source: 'https://github.com/someone/otherskill', installedAt: '2026-04-05T00:00:00.000Z' },
      ],
    }
    fs.writeFileSync(TEST_SKILLS_JSON, JSON.stringify(registry), { mode: 0o600 })

    const lines: string[] = []
    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      lines.push(msg)
    })

    await runCommand(['list'])

    mockConsoleLog.mockRestore()

    const output = lines.join('\n')
    expect(output).toContain('throwmail')
    expect(output).toContain('https://github.com/test-owner/test-skill')
    expect(output).toContain('otherskill')
    expect(output).toContain('https://github.com/someone/otherskill')
  })

  it('prints empty message when no skills installed', async () => {
    const lines: string[] = []
    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      lines.push(msg)
    })

    await runCommand(['list'])

    mockConsoleLog.mockRestore()

    const output = lines.join('\n')
    expect(output.toLowerCase()).toMatch(/no skills|0 skills|empty/)
  })
})

describe('skills remove', () => {
  it('deletes skill directory and removes entry from skills.json', async () => {
    // Set up: create skill directory and skills.json
    const skillDir = path.join(TEST_SKILLS_DIR, 'throwmail')
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Throwmail')
    fs.writeFileSync(path.join(skillDir, 'references', 'guide.md'), 'Guide content')

    const registry = {
      skills: [
        { name: 'throwmail', source: 'https://github.com/test-owner/test-skill', installedAt: '2026-04-06T00:00:00.000Z' },
        { name: 'other', source: 'https://github.com/x/other', installedAt: '2026-04-05T00:00:00.000Z' },
      ],
    }
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(TEST_SKILLS_JSON, JSON.stringify(registry), { mode: 0o600 })

    const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCommand(['remove', 'throwmail'])

    mockConsoleLog.mockRestore()

    // Skill directory deleted
    expect(fs.existsSync(skillDir)).toBe(false)

    // skills.json updated — throwmail removed, other still present
    const updated = JSON.parse(fs.readFileSync(TEST_SKILLS_JSON, 'utf-8')) as {
      skills: Array<{ name: string }>
    }
    expect(updated.skills).toHaveLength(1)
    expect(updated.skills[0]!.name).toBe('other')
  })

  it('exits non-zero when skill is not installed', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCommand(['remove', 'nonexistent'])).rejects.toThrow()

    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
    mockConsoleError.mockRestore()
  })
})
