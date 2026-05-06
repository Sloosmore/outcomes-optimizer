import { describe, it, expect } from 'vitest'
import { generateCloudflaredConfig } from '../lib/cloudflared-config.js'

const TEST_SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const TEST_TUNNEL_ID = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb'

describe('generateCloudflaredConfig', () => {
  const config = generateCloudflaredConfig({
    serverId: TEST_SERVER_ID,
    tunnelId: TEST_TUNNEL_ID,
  })

  it('contains tunnel: {tunnelId}', () => {
    expect(config).toContain(`tunnel: ${TEST_TUNNEL_ID}`)
  })

  it('contains *.{serverId}.example.com as hostname', () => {
    expect(config).toContain(`*.${TEST_SERVER_ID}.example.com`)
  })

  it('contains service: http://localhost:8080 by default', () => {
    expect(config).toContain('service: http://localhost:8080')
  })

  it('contains service: http_status:404 fallback', () => {
    expect(config).toContain('service: http_status:404')
  })

  it('uses custom routerPort when provided', () => {
    const customConfig = generateCloudflaredConfig({
      serverId: TEST_SERVER_ID,
      tunnelId: TEST_TUNNEL_ID,
      routerPort: 9090,
    })
    expect(customConfig).toContain('service: http://localhost:9090')
  })

  it('contains credentials-file:', () => {
    expect(config).toContain('credentials-file:')
  })

  it('contains no-autoupdate: true', () => {
    expect(config).toContain('no-autoupdate: true')
  })
})
