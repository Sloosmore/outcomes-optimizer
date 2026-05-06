import { describe, it, expect } from 'vitest'
import { AuthDbService } from '../auth-db.js'

function makeMockSql(config: {
  findUserRow?: { id: string } | null
  upsertUserRow?: { id: string } | null
}) {
  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')

    if (query.includes('SELECT id') && query.includes('auth.users') && query.includes('email =')) {
      if (config.findUserRow === null || config.findUserRow === undefined) {
        return Promise.resolve([])
      }
      return Promise.resolve([config.findUserRow])
    }

    if (query.includes('INSERT INTO auth.users')) {
      if (config.upsertUserRow === null || config.upsertUserRow === undefined) {
        return Promise.resolve([])
      }
      return Promise.resolve([config.upsertUserRow])
    }

    return Promise.resolve([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock for postgres Sql client (not bound by postgres type)
  } as any
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

describe('AuthDbService', () => {
  describe('findUserByEmail', () => {
    it('returns null when user is not found', async () => {
      const mockSql = makeMockSql({ findUserRow: null })
      const service = new AuthDbService(mockSql)
      const result = await service.findUserByEmail('notfound@example.com')
      expect(result).toBeNull()
    })

    it('returns user object when user is found', async () => {
      const userId = 'a1b2c3d4-0000-0000-0000-000000000000'
      const mockSql = makeMockSql({ findUserRow: { id: userId } })
      const service = new AuthDbService(mockSql)
      const result = await service.findUserByEmail('found@example.com')
      expect(result).not.toBeNull()
      expect(result?.id).toBe(userId)
    })
  })

  describe('upsertUser', () => {
    it('returns the user id after upsert without providing a userId', async () => {
      const generatedId = 'generated-uuid-0000-0000-000000000000'
      const mockSql = makeMockSql({ upsertUserRow: { id: generatedId } })
      const service = new AuthDbService(mockSql)
      const result = await service.upsertUser('newuser@example.com')
      expect(result).not.toBeNull()
      expect(result.id).toBe(generatedId)
    })

    it('returns the user id after upsert when a userId is provided', async () => {
      const specificId = 'specific-uuid-1234-0000-000000000000'
      const mockSql = makeMockSql({ upsertUserRow: { id: specificId } })
      const service = new AuthDbService(mockSql)
      const result = await service.upsertUser('existing@example.com', specificId)
      expect(result).not.toBeNull()
      expect(result.id).toBe(specificId)
    })

    it('handles conflict update (email already exists) returning existing id', async () => {
      const existingId = 'existing-user-id-0000-000000000000'
      const mockSql = makeMockSql({ upsertUserRow: { id: existingId } })
      const service = new AuthDbService(mockSql)
      // On conflict, Postgres returns the existing row's id
      const result = await service.upsertUser('duplicate@example.com')
      expect(result.id).toBe(existingId)
    })
  })
})
