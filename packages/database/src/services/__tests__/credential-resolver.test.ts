import { describe, it, expect } from 'vitest'
import { CredentialResolverService } from '../credential-resolver.js'

type MockConfig = {
  resourceRow?: { id: string; name: string; type: string; config: Record<string, unknown> } | null
  linkRow?: { to_id: string } | null
  credentialResourceRow?: { config: Record<string, unknown> } | null
  proxyRow?: { proxy_url_env_var: string } | null
}

function makeMockSql(config: MockConfig) {
  const mockSql = function(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const query = strings.raw.join('?')

    // First query: SELECT id, name, type, config FROM resources WHERE name = ...
    if (query.includes('FROM resources') && query.includes('name =')) {
      if (config.resourceRow === null || config.resourceRow === undefined) {
        return Promise.resolve([])
      }
      return Promise.resolve([config.resourceRow])
    }

    // Second query: SELECT to_id FROM resource_links WHERE from_id = ...
    if (query.includes('FROM resource_links')) {
      if (config.linkRow === null || config.linkRow === undefined) {
        return Promise.resolve([])
      }
      return Promise.resolve([config.linkRow])
    }

    // Third query: SELECT config FROM resources WHERE id = ... (credential resource)
    if (query.includes('FROM resources') && query.includes('id =') && query.includes('config')) {
      // Proxy query vs credential resource query
      if (query.includes('type =') && query.includes('proxy')) {
        if (config.proxyRow === null || config.proxyRow === undefined) {
          return Promise.resolve([])
        }
        return Promise.resolve([config.proxyRow])
      }
      if (config.credentialResourceRow === null || config.credentialResourceRow === undefined) {
        return Promise.resolve([])
      }
      return Promise.resolve([config.credentialResourceRow])
    }

    return Promise.resolve([])
  } as unknown as ReturnType<typeof import('postgres').default>
  mockSql.array = (arr: unknown[]) => arr
  mockSql.json = (obj: unknown) => obj
  return mockSql
}

describe('CredentialResolverService', () => {
  describe('resolveByName', () => {
    it('returns null when resource not found', async () => {
      const mockSql = makeMockSql({ resourceRow: null })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('nonexistent')
      expect(result).toBeNull()
    })

    it('returns null when resource has no credential link and no inline credential config', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: { urls: ['api.example.com'] } },
        linkRow: null,
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result).toBeNull()
    })

    it('resolves credential from linked credential resource', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: { urls: ['api.example.com'] } },
        linkRow: { to_id: 'cred-res-1' },
        credentialResourceRow: {
          config: {
            dopplerProject: 'my-project',
            envVars: ['API_KEY'],
            injectAs: 'bearer',
          },
        },
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result).not.toBeNull()
      expect(result?.resourceName).toBe('my-resource')
      expect(result?.dopplerProject).toBe('my-project')
      expect(result?.envVars).toEqual(['API_KEY'])
      expect(result?.urls).toEqual(['api.example.com'])
      expect(result?.injectAs).toBe('bearer')
      expect(result?.resourceId).toBe('res-1')
    })

    it('resolves credential with inline config when no link exists', async () => {
      const mockSql = makeMockSql({
        resourceRow: {
          id: 'res-2',
          name: 'inline-resource',
          type: 'identity',
          config: {
            urls: ['api2.example.com'],
            dopplerProject: 'inline-project',
            envVars: ['TOKEN'],
          },
        },
        linkRow: null,
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('inline-resource')
      expect(result).not.toBeNull()
      expect(result?.dopplerProject).toBe('inline-project')
      expect(result?.envVars).toEqual(['TOKEN'])
    })

    it('returns null when linked credential resource is not found', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: { urls: [] } },
        linkRow: { to_id: 'missing-cred' },
        credentialResourceRow: null,
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result).toBeNull()
    })

    it('returns null when credential config is missing required fields', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: {} },
        linkRow: { to_id: 'cred-res-1' },
        credentialResourceRow: {
          config: { someOtherField: 'value' },
        },
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result).toBeNull()
    })

    it('resolves direct headerValue credential without dopplerProject', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'app-1', name: 'test-app', type: 'app', config: { urls: ['httpbin.org'] } },
        linkRow: { to_id: 'cred-direct-1' },
        credentialResourceRow: {
          config: {
            headerName: 'X-Test-Auth',
            headerValue: 'test-token-123',
          },
        },
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('test-app')
      expect(result).not.toBeNull()
      expect(result?.headerName).toBe('X-Test-Auth')
      expect(result?.headerValue).toBe('test-token-123')
      expect(result?.urls).toEqual(['httpbin.org'])
      expect(result?.envVars).toEqual([])
      expect(result?.dopplerProject).toBe('')
    })

    it('defaults injectAs to bearer when not specified', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: { urls: [] } },
        linkRow: { to_id: 'cred-1' },
        credentialResourceRow: {
          config: {
            dopplerProject: 'proj',
            envVars: ['KEY'],
            // no injectAs
          },
        },
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result?.injectAs).toBe('bearer')
    })

    it('returns empty urls array when config has no urls', async () => {
      const mockSql = makeMockSql({
        resourceRow: { id: 'res-1', name: 'my-resource', type: 'identity', config: {} },
        linkRow: { to_id: 'cred-1' },
        credentialResourceRow: {
          config: {
            dopplerProject: 'proj',
            envVars: ['KEY'],
          },
        },
      })
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByName('my-resource')
      expect(result?.urls).toEqual([])
    })
  })

  describe('resolveByHostname', () => {
    it('returns null for empty hostname', async () => {
      const mockSql = makeMockSql({})
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByHostname('')
      expect(result).toBeNull()
    })

    it('returns null for hostname that is too long', async () => {
      const mockSql = makeMockSql({})
      const service = new CredentialResolverService(mockSql)
      const longHostname = 'a'.repeat(254)
      const result = await service.resolveByHostname(longHostname)
      expect(result).toBeNull()
    })

    it('returns null for hostname with invalid characters', async () => {
      const mockSql = makeMockSql({})
      const service = new CredentialResolverService(mockSql)
      const result = await service.resolveByHostname('bad hostname!')
      expect(result).toBeNull()
    })
  })
})
