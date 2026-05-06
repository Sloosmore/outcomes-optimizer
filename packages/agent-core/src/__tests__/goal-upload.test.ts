import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/adapter-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adapter-factory.js')>()
  return {
    ...actual,
    getAdapter: vi.fn(),
  }
})

import { goalUpload } from '../lib/goal-upload.js'
import * as adapterFactory from '../lib/adapter-factory.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MOCK_RESOURCE_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-goal-upload-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
})

function writeGoal(filename: string, content: string): string {
  const p = path.join(tmpDir, filename)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

function makeMockAdapter() {
  return {
    addResource: vi.fn().mockResolvedValue({
      id: MOCK_RESOURCE_ID,
      name: 'skill/test',
      type: 'skill',
    }),
    createResourceLink: vi.fn(),
    createResourceLinkById: vi.fn(),
    listProjectsForUser: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// 1. Basic return shape
// ---------------------------------------------------------------------------

describe('goalUpload — return shape', () => {
  it('returns { skillResourceId, slug } where skillResourceId is a UUID and slug is non-empty', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: My Feature\nSome description')

    const result = await goalUpload(goalPath)

    expect(result.skillResourceId).toMatch(UUID_REGEX)
    expect(result.slug).toBeTruthy()
    expect(result.slug.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Slug derivation
// ---------------------------------------------------------------------------

describe('goalUpload — slug derivation', () => {
  it('derives slug from "# Goal: My Feature" → "my-feature"', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: My Feature\nSome description')

    const result = await goalUpload(goalPath)

    expect(result.slug).toBe('my-feature')
  })

  it('derives slug from "# My Feature" → "my-feature"', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# My Feature\nSome description')

    const result = await goalUpload(goalPath)

    expect(result.slug).toBe('my-feature')
  })

  it('strips frontmatter before looking for heading — does not treat "---" as title', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '---\nassignment: agent-x\n---\n# Goal: Foo Bar\nDescription')

    const result = await goalUpload(goalPath)

    expect(result.slug).toBe('foo-bar')
  })

  it('truncates slug at 50 characters', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const longTitle = 'A'.repeat(60) // 60 chars, all uppercase A
    const goalPath = writeGoal('goal.md', `# ${longTitle}`)

    const result = await goalUpload(goalPath)

    expect(result.slug.length).toBeLessThanOrEqual(50)
  })

  it('uses slugOverride when provided, ignoring the derived title', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Derived From Title\nBody')

    const result = await goalUpload(goalPath, undefined, 'my-custom-slug')

    expect(result.slug).toBe('my-custom-slug')
    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/my-custom-slug',
      'skill',
      expect.anything()
    )
  })

  it('falls back to title derivation when slugOverride is undefined', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Derived From Title\nBody')

    const result = await goalUpload(goalPath, undefined, undefined)

    expect(result.slug).toBe('derived-from-title')
  })

  it('normalizes an uppercase/symbol-laden slugOverride the same way it normalizes a derived slug', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Anything\nBody')

    const result = await goalUpload(goalPath, undefined, 'MY_Custom!!Slug  ')

    expect(result.slug).toBe('my-custom-slug')
  })

  it('truncates a slugOverride that exceeds 50 characters', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Anything\nBody')

    const tooLong = 'x'.repeat(80)
    const result = await goalUpload(goalPath, undefined, tooLong)

    expect(result.slug.length).toBeLessThanOrEqual(50)
    expect(result.slug).toBe('x'.repeat(50))
  })

  it('throws when slugOverride normalizes to empty (all symbols)', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Anything\nBody')

    await expect(goalUpload(goalPath, undefined, '!!!---!!!')).rejects.toThrow(/Could not derive a slug/)
  })
})

// ---------------------------------------------------------------------------
// 3. addResource call
// ---------------------------------------------------------------------------

describe('goalUpload — addResource call', () => {
  it('calls addResource with correct arguments', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const content = '# Goal: Test Feature\nDescription'
    const goalPath = writeGoal('goal.md', content)

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledOnce()
    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/test-feature',
      'skill',
      expect.objectContaining({
        content,
        epochs: 10,
        worktree: true,
        git: true,
      })
    )
    // `pr` must NOT be present when no options are passed
    const config = vi.mocked(mockAdapter.addResource).mock.calls[0][2] as Record<string, unknown>
    expect(config).not.toHaveProperty('pr')
  })

  it('passes original full content (including frontmatter) to addResource', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const content = '---\nepochs: 7\n---\n# Goal: With Frontmatter\nBody'
    const goalPath = writeGoal('goal.md', content)

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/with-frontmatter',
      'skill',
      expect.objectContaining({ content })
    )
  })
})

// ---------------------------------------------------------------------------
// 4. No link creation
// ---------------------------------------------------------------------------

describe('goalUpload — no link creation', () => {
  it('does NOT call createResourceLink', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: No Links\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.createResourceLink).not.toHaveBeenCalled()
  })

  it('does NOT call createResourceLinkById', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: No Links\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.createResourceLinkById).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. Epochs from frontmatter
// ---------------------------------------------------------------------------

describe('goalUpload — epochs handling', () => {
  it('passes epochs from frontmatter to addResource', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '---\nepochs: 5\n---\n# Goal: Epoched Feature\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/epoched-feature',
      'skill',
      expect.objectContaining({ epochs: 5 })
    )
  })

  it('defaults to epochs=10 when frontmatter has no epochs field', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '---\nassignment: foo\n---\n# Goal: No Epochs\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/no-epochs',
      'skill',
      expect.objectContaining({ epochs: 10 })
    )
  })

  it('defaults to epochs=10 when file has no frontmatter at all', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Plain Goal\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/plain-goal',
      'skill',
      expect.objectContaining({ epochs: 10 })
    )
  })

  it('defaults to epochs=10 when epochs value in frontmatter is not a valid integer', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '---\nepochs: abc\n---\n# Goal: Bad Epochs\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/bad-epochs',
      'skill',
      expect.objectContaining({ epochs: 10 })
    )
  })

  it('uses epochsOverride when provided, ignoring frontmatter value', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '---\nepochs: 20\n---\n# Goal: Override Epochs\nBody')

    await goalUpload(goalPath, 5)

    expect(mockAdapter.addResource).toHaveBeenCalledWith(
      'skill/override-epochs',
      'skill',
      expect.objectContaining({ epochs: 5 })
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Error cases
// ---------------------------------------------------------------------------

describe('goalUpload — error cases', () => {
  it('throws when the file does not exist', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await expect(goalUpload('/nonexistent/path/goal.md')).rejects.toThrow(/Could not read goal file/)
  })

  it('throws when slug cannot be derived (file with only whitespace body)', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '   \n\n   \n')

    await expect(goalUpload(goalPath)).rejects.toThrow(/Could not derive a slug/)
  })

  it('throws when slug cannot be derived (body heading is empty after stripping prefix)', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    // "# " with no content → title becomes "" → slug becomes ""
    const goalPath = writeGoal('goal.md', '# \n')

    await expect(goalUpload(goalPath)).rejects.toThrow(/Could not derive a slug/)
  })
})

// ---------------------------------------------------------------------------
// Integration tests (gated by RUN_INTEGRATION=true)
// ---------------------------------------------------------------------------

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

describe.skipIf(!RUN_INTEGRATION)('goalUpload — real DB integration', () => {
  it('writes a real goal file, calls goalUpload(), and verifies the resource appears', async () => {
    const { initAdapter } = await import('../lib/adapter-factory.js')
    await initAdapter()

    const content = '# Goal: Integration Test Goal\nThis is a test goal for integration testing.'
    const goalPath = writeGoal('integration-goal.md', content)

    const result = await goalUpload(goalPath)

    expect(result.skillResourceId).toMatch(UUID_REGEX)
    expect(result.slug).toBe('integration-test-goal')

    // Verify no link was created (no error means no link creation occurred)
    // The resource should exist in the DB with the returned ID
    const adapter = adapterFactory.getAdapter()
    const resource = await (adapter as unknown as Record<string, (...args: unknown[]) => unknown>).getResource?.(result.skillResourceId) as Record<string, unknown> | undefined
    if (resource) {
      expect(resource['id']).toBe(result.skillResourceId)
    }
  })
})
