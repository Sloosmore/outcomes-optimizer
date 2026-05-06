import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Hoisted mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../lib/require-auth.js', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('../lib/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/helpers.js')>()
  return { ...actual, getApiBaseUrl: vi.fn().mockReturnValue('http://test.local') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, default: { ...actual, homedir: vi.fn().mockReturnValue(actual.homedir()) } }
})

// Mock getCLITarget so syncSkills doesn't require config.yaml when run from packages/duoidal-cli/
vi.mock('@duoidal/utils/cli', async () => {
  return {
    getCLITarget: vi.fn().mockReturnValue({ skillsDir: '/tmp/unused-skills-dir' }),
  }
})

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { writeSkillsToConfig, fetchAndWriteSkills } from '../lib/bundled-skills.js'
import { requireAuth } from '../lib/require-auth.js'
import { getApiBaseUrl } from '../lib/helpers.js'
import { syncSkills } from '@duoidal/utils/sync'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.mocked(requireAuth)
const mockGetApiBaseUrl = vi.mocked(getApiBaseUrl)

// Resolve the project root relative to this test file:
// packages/duoidal-cli/src/__tests__/ → root is 4 levels up
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
const ROOT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills')

// Read distributable skill names from the manifest (single source of truth)
const SKILL_NAMES: string[] = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'packages/duoidal-cli/skills.manifest.json'), 'utf8')
).distributable

function buildJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.fake-sig`
}

function mockFetchResponse(status: number, body: ArrayBuffer | null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body ?? new ArrayBuffer(0)),
  } as unknown as Response
}

function stubFetch(responses: Response[]): void {
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? responses[responses.length - 1]))
  )
}

// ---------------------------------------------------------------------------
// writeSkillsToConfig tests (existing — kept intact)
// ---------------------------------------------------------------------------

describe('writeSkillsToConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-test-skills-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes SKILL.md for every distributable skill', () => {
    writeSkillsToConfig({ configSkillsDir: tmpDir, bundledSkillsRoot: ROOT_SKILLS_DIR })

    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(tmpDir, skillName, 'SKILL.md'))).toBe(true)
      const written = fs.readFileSync(path.join(tmpDir, skillName, 'SKILL.md'), 'utf-8')
      const root = fs.readFileSync(path.join(ROOT_SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8')
      expect(written).toBe(root)
    }
  })

  it('copies references/ subdirectory when present', () => {
    writeSkillsToConfig({ configSkillsDir: tmpDir, bundledSkillsRoot: ROOT_SKILLS_DIR })

    // Only check skills that actually have a references/ dir in the source
    const skillsWithRefs = SKILL_NAMES.filter(name =>
      fs.existsSync(path.join(ROOT_SKILLS_DIR, name, 'references'))
    )
    expect(skillsWithRefs.length).toBeGreaterThan(0) // at least some skills have references
    for (const skillName of skillsWithRefs) {
      expect(fs.existsSync(path.join(tmpDir, skillName, 'references'))).toBe(true)
    }
  })

  it('is idempotent: second call produces same output', () => {
    writeSkillsToConfig({ configSkillsDir: tmpDir, bundledSkillsRoot: ROOT_SKILLS_DIR })
    writeSkillsToConfig({ configSkillsDir: tmpDir, bundledSkillsRoot: ROOT_SKILLS_DIR })

    for (const skillName of SKILL_NAMES) {
      const written = fs.readFileSync(path.join(tmpDir, skillName, 'SKILL.md'), 'utf-8')
      const root = fs.readFileSync(path.join(ROOT_SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8')
      expect(written).toBe(root)
    }
  })

  it('integration: writeSkillsToConfig → syncSkills picks up both skills', () => {
    const userSkillsDir = path.join(tmpDir, '0a9b5646-fbfa-455c-820b-946382437807')
    const repoSkillsDir = path.join(tmpDir, 'repo-skills')
    const targetDir = path.join(tmpDir, 'target')

    // Empty repo skills dir (no skills from repo), user skills from writeSkillsToConfig
    fs.mkdirSync(repoSkillsDir, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })

    writeSkillsToConfig({ configSkillsDir: userSkillsDir, bundledSkillsRoot: ROOT_SKILLS_DIR })

    const results = syncSkills({
      skillsRoot: repoSkillsDir,
      userSkillsRoot: userSkillsDir,
      targetDir,
    })

    // All distributable skills should have been synced
    const skillNames = results.map(r => r.skillName)
    for (const skillName of SKILL_NAMES) {
      expect(skillNames).toContain(skillName)
      expect(fs.existsSync(path.join(targetDir, skillName, 'SKILL.md'))).toBe(true)
    }

    // Content should match root skills (spot-check first skill)
    const firstSkill = SKILL_NAMES[0]!
    const synced = fs.readFileSync(path.join(targetDir, firstSkill, 'SKILL.md'), 'utf-8')
    const root = fs.readFileSync(path.join(ROOT_SKILLS_DIR, firstSkill, 'SKILL.md'), 'utf-8')
    expect(synced).toBe(root)
  })
})

// ---------------------------------------------------------------------------
// fetchAndWriteSkills tests
// ---------------------------------------------------------------------------

describe('fetchAndWriteSkills', () => {
  // Tarballs built once per suite
  const skillTarballs: Record<string, Buffer> = {}
  let fetchTestTmpDir: string

  beforeAll(() => {
    // Build real minimal tarballs for all distributable skills
    const sourceBase = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-skill-src-'))
    for (const skillName of SKILL_NAMES) {
      const skillSrcDir = path.join(sourceBase, skillName)
      fs.mkdirSync(skillSrcDir, { recursive: true })
      fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), `# ${skillName}\ntest skill content for ${skillName}\n`)
      const tarPath = path.join(sourceBase, `${skillName}.tar.gz`)
      execSync(`tar czf "${tarPath}" -C "${sourceBase}" "${skillName}"`)
      skillTarballs[skillName] = fs.readFileSync(tarPath)
    }
  })

  beforeEach(() => {
    vi.unstubAllGlobals()
    mockRequireAuth.mockReset()
    mockGetApiBaseUrl.mockReturnValue('http://test.local')

    // Default valid token
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const token = buildJwt({ sub: '00000000-0000-4000-8000-000000000001', exp: futureExp })
    mockRequireAuth.mockResolvedValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: token, refreshToken: '' })

    // Per-test isolated temp dir that acts as home dir
    fetchTestTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-fetch-test-'))

    // Point os.homedir() to the temp dir so fetchAndWriteSkills writes there
    const osMod = os as unknown as { homedir: ReturnType<typeof vi.fn> }
    osMod.homedir.mockReturnValue(fetchTestTmpDir)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
    if (fetchTestTmpDir) {
      fs.rmSync(fetchTestTmpDir, { recursive: true, force: true })
    }
  })

  it('(a) successful fetch: writes skills to configSkillsDir', async () => {
    // Build array of responses: one per distributable skill
    const responses = SKILL_NAMES.map(skillName => {
      const buf = skillTarballs[skillName]!
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      return mockFetchResponse(200, ab)
    })
    stubFetch(responses)

    await fetchAndWriteSkills()

    const configSkillsDir = path.join(fetchTestTmpDir, '.config', 'duoidal', 'skills')
    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(configSkillsDir, skillName, 'SKILL.md'))).toBe(true)
    }

    const firstSkill = SKILL_NAMES[0]!
    const content = fs.readFileSync(path.join(configSkillsDir, firstSkill, 'SKILL.md'), 'utf-8')
    expect(content).toContain(firstSkill)
  })

  it('(b) BFF returns 404: falls back to bundled skills', async () => {
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // All skills return 404 from BFF
    stubFetch(SKILL_NAMES.map(() => mockFetchResponse(404, null)))

    await fetchAndWriteSkills({ bundledSkillsRoot: ROOT_SKILLS_DIR })

    const configSkillsDir = path.join(fetchTestTmpDir, '.config', 'duoidal', 'skills')
    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(configSkillsDir, skillName, 'SKILL.md'))).toBe(true)
    }
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('not in bucket — using bundled version')
    )

    mockConsoleError.mockRestore()
  })

  it('(c) BFF returns non-OK status: falls back to bundled skills', async () => {
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    stubFetch(SKILL_NAMES.map(() => mockFetchResponse(500, null)))

    await fetchAndWriteSkills({ bundledSkillsRoot: ROOT_SKILLS_DIR })

    const configSkillsDir = path.join(fetchTestTmpDir, '.config', 'duoidal', 'skills')
    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(configSkillsDir, skillName, 'SKILL.md'))).toBe(true)
    }
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('using bundled version')
    )

    mockConsoleError.mockRestore()
  })

  it('(d) network error: falls back to bundled skills for all remaining', async () => {
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await fetchAndWriteSkills({ bundledSkillsRoot: ROOT_SKILLS_DIR })

    const configSkillsDir = path.join(fetchTestTmpDir, '.config', 'duoidal', 'skills')
    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(configSkillsDir, skillName, 'SKILL.md'))).toBe(true)
    }
    expect(mockConsoleError).toHaveBeenCalledWith(
      'BFF unreachable — falling back to bundled skills'
    )

    mockConsoleError.mockRestore()
  })

  it('(e) second run is idempotent: skills exist and content is correct after both calls', async () => {
    const makeResponses = () =>
      SKILL_NAMES.map(skillName => {
        const buf = skillTarballs[skillName]!
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        return mockFetchResponse(200, ab)
      })

    // First call
    stubFetch(makeResponses())
    await fetchAndWriteSkills()

    // Second call — reset fetch mock
    vi.unstubAllGlobals()
    stubFetch(makeResponses())
    await fetchAndWriteSkills()

    const configSkillsDir = path.join(fetchTestTmpDir, '.config', 'duoidal', 'skills')
    for (const skillName of SKILL_NAMES) {
      expect(fs.existsSync(path.join(configSkillsDir, skillName, 'SKILL.md'))).toBe(true)
    }

    const firstSkill = SKILL_NAMES[0]!
    const content = fs.readFileSync(path.join(configSkillsDir, firstSkill, 'SKILL.md'), 'utf-8')
    expect(content).toContain(firstSkill)
  })
})
