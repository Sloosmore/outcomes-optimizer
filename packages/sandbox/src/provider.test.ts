import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockSandboxProvider } from './mock.js';
import { HetznerProvider } from './hetzner.js';
import { createSandboxProvider } from './index.js';
import type { ProvisionOptions } from './provider.js';

// ─── Shared test fixture ─────────────────────────────────────────────────────

const provisionOpts: ProvisionOptions = {
  resourceId: 'res-123',
  serverName: 'test-server',
  publicKey: 'ssh-ed25519 AAAAC3... test@example.com',
  sshKeyName: 'test-key',
  dopplerToken: 'dp.st.test.abc123',
  provisionSecret: 'secret-abc',
  agentLivestreamUrl: 'https://agent.example.com/sandbox/ready',
  bootstrapScript: Buffer.from('#!/bin/bash\necho hello').toString('base64'),
};

// ─── MockSandboxProvider tests ────────────────────────────────────────────────

describe('MockSandboxProvider', () => {
  it('provision() returns ProvisionResult with status provisioning and a hetznerServerId', async () => {
    const provider = new MockSandboxProvider();
    const result = await provider.provision(provisionOpts);
    expect(result.status).toBe('provisioning');
    expect(result.hetznerServerId).toBeTruthy();
    expect(typeof result.hetznerServerId).toBe('string');
  });

  it('getStatus() returns ServerStatusResult with status active for a provisioned server', async () => {
    const provider = new MockSandboxProvider();
    const provisionResult = await provider.provision(provisionOpts);
    const statusResult = await provider.getStatus(provisionResult.hetznerServerId);
    expect(statusResult.status).toBe('active');
    expect(statusResult.hetznerServerId).toBe(provisionResult.hetznerServerId);
    expect(statusResult.ip).toBe('1.2.3.4');
  });

  it('deprovision() resolves without error for a provisioned server', async () => {
    const provider = new MockSandboxProvider();
    const provisionResult = await provider.provision(provisionOpts);
    await expect(provider.deprovision(provisionResult.hetznerServerId)).resolves.toBeUndefined();
  });

  it('provision() throws when failProvision=true', async () => {
    const provider = new MockSandboxProvider({ failProvision: true });
    await expect(provider.provision(provisionOpts)).rejects.toThrow();
  });

  it('getStatus() throws for unknown server ID', async () => {
    const provider = new MockSandboxProvider();
    await expect(provider.getStatus('unknown-server-id')).rejects.toThrow();
  });

  it('deprovision() throws for unknown server ID', async () => {
    const provider = new MockSandboxProvider();
    await expect(provider.deprovision('unknown-server-id')).rejects.toThrow();
  });
});

// ─── HetznerProvider tests (fetch mocked via vi.stubGlobal) ──────────────────

describe('HetznerProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFetchResponse(status: number, body: unknown): Response {
    const serialized = JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => serialized,
      json: async () => body,
    } as unknown as Response;
  }

  it('provision() makes correct API calls (ssh_keys + servers) and returns ProvisionResult', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(201, { ssh_key: { id: 42, name: 'test-key' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 999,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);

    expect(result.hetznerServerId).toBe('999');
    expect(result.status).toBe('provisioning');

    // Verify ssh_keys call
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.hetzner.cloud/v1/ssh_keys',
      expect.objectContaining({ method: 'POST' })
    );

    // Verify servers call
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.hetzner.cloud/v1/servers',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('provision() handles 409 by deleting stale SSH key and re-creating', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [{ id: 42, name: 'test-key' }] })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(204, {})
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, { ssh_key: { id: 99, name: 'test-key' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 777,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);

    expect(result.hetznerServerId).toBe('777');
    expect(result.status).toBe('provisioning');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      'https://api.hetzner.cloud/v1/ssh_keys/42',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('provision() handles 422 (public_key conflict) by finding key in all keys and deleting', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(422, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        // listByName returns empty — key registered under different name
        makeFetchResponse(200, { ssh_keys: [] })
      )
      .mockResolvedValueOnce(
        // listAll finds the key by matching public_key
        makeFetchResponse(200, {
          ssh_keys: [
            { id: 55, name: 'old-key-name', public_key: 'ssh-ed25519 AAAAC3... test@example.com' },
          ],
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(204, {})
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, { ssh_key: { id: 99, name: 'test-key' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 888,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);

    expect(result.hetznerServerId).toBe('888');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      'https://api.hetzner.cloud/v1/ssh_keys/55',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('provision() finds public_key conflict across multiple pages (pagination)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(422, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [] })
      )
      .mockResolvedValueOnce(
        // Page 1: key not here, but next_page signals more pages
        makeFetchResponse(200, {
          ssh_keys: [{ id: 10, name: 'other', public_key: 'ssh-rsa OTHER' }],
          meta: { pagination: { next_page: 2 } },
        })
      )
      .mockResolvedValueOnce(
        // Page 2: key found here
        makeFetchResponse(200, {
          ssh_keys: [{ id: 77, name: 'old-key', public_key: 'ssh-ed25519 AAAAC3... test@example.com' }],
          meta: { pagination: { next_page: null } },
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(204, {})
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, { ssh_key: { id: 99, name: 'test-key' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 900,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);

    expect(result.hetznerServerId).toBe('900');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock).toHaveBeenNthCalledWith(5,
      'https://api.hetzner.cloud/v1/ssh_keys/77',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('provision() throws when SSH key re-create fails after deleting stale key', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [{ id: 42, name: 'test-key' }] })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(204, {})
      )
      .mockResolvedValueOnce(
        // Re-create fails (e.g. concurrent conflict or server error)
        makeFetchResponse(500, { error: { message: 'internal error' } })
      );

    const provider = new HetznerProvider('test-token');
    await expect(provider.provision(provisionOpts)).rejects.toThrow('Failed to re-create SSH key after conflict: HTTP 500');
  });

  it('provision() handles TOCTOU: re-create 409 when concurrent provisioner already re-created matching key', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [{ id: 42, name: 'test-key' }] })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(204, {})
      )
      .mockResolvedValueOnce(
        // Concurrent provisioner re-created the key first
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        // Verify: existing key has the correct public_key — proceed
        makeFetchResponse(200, { ssh_keys: [{ id: 99, name: 'test-key', public_key: provisionOpts.publicKey }] })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 555,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);
    expect(result.hetznerServerId).toBe('555');
  });

  it('provision() throws when SSH key conflict cannot be resolved', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(422, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [] })
      )
      .mockResolvedValueOnce(
        // listAll returns keys but none match the public key
        makeFetchResponse(200, { ssh_keys: [{ id: 1, name: 'other', public_key: 'ssh-rsa OTHER' }] })
      );

    const provider = new HetznerProvider('test-token');
    await expect(provider.provision(provisionOpts)).rejects.toThrow('SSH key conflict but key not found');
  });

  it('provision() throws when initial SSH key POST fails with non-409/422 error', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(500, { error: { message: 'internal server error' } })
    );

    const provider = new HetznerProvider('test-token');
    await expect(provider.provision(provisionOpts)).rejects.toThrow('Failed to create SSH key: HTTP 500');
  });

  it('provision() throws when DELETE stale SSH key fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [{ id: 42, name: 'test-key' }] })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(403, { error: { message: 'forbidden' } })
      );

    const provider = new HetznerProvider('test-token');
    await expect(provider.provision(provisionOpts)).rejects.toThrow('Failed to delete stale SSH key 42: HTTP 403');
  });

  it('getStatus() parses server status correctly', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        server: {
          id: 123,
          status: 'running',
          public_net: { ipv4: { ip: '5.6.7.8' } },
        },
      })
    );

    const provider = new HetznerProvider('test-token');
    const result = await provider.getStatus('123');

    expect(result.hetznerServerId).toBe('123');
    expect(result.status).toBe('active');
    expect(result.ip).toBe('5.6.7.8');
  });

  it('getStatus() maps initializing to provisioning', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse(200, {
        server: {
          id: 123,
          status: 'initializing',
          public_net: { ipv4: { ip: null } },
        },
      })
    );

    const provider = new HetznerProvider('test-token');
    const result = await provider.getStatus('123');
    expect(result.status).toBe('provisioning');
  });

  it('provision() treats 404 on stale SSH key DELETE as success (concurrent race)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse(409, { error: { code: 'uniqueness_error' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(200, { ssh_keys: [{ id: 42, name: 'test-key' }] })
      )
      .mockResolvedValueOnce(
        // Another provisioner already deleted the key
        makeFetchResponse(404, { error: { message: 'not found' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, { ssh_key: { id: 99, name: 'test-key' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse(201, {
          server: {
            id: 888,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        })
      );

    const provider = new HetznerProvider('test-token');
    const result = await provider.provision(provisionOpts);
    expect(result.hetznerServerId).toBe('888');
  });

  it('surfaces non-JSON error body in thrown error message', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 502,
      ok: false,
      text: async () => '<html>Bad Gateway</html>',
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);

    const provider = new HetznerProvider('test-token');
    await expect(provider.provision(provisionOpts)).rejects.toThrow(
      'Failed to create SSH key: HTTP 502 — body: <html>Bad Gateway</html>'
    );
  });

  it('deprovision() calls DELETE correctly', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(204, {}));

    const provider = new HetznerProvider('test-token');
    await expect(provider.deprovision('123')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers/123',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('deprovision() treats 404 as success (idempotent)', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(404, { error: { message: 'not found' } }));

    const provider = new HetznerProvider('test-token');
    await expect(provider.deprovision('123')).resolves.toBeUndefined();
  });

  it('user_data does NOT contain sensitive env vars', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    fetchMock
      .mockImplementationOnce(async (_url: string, _init: RequestInit) => {
        return makeFetchResponse(201, { ssh_key: { id: 42, name: 'test-key' } });
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return makeFetchResponse(201, {
          server: {
            id: 999,
            status: 'initializing',
            public_net: { ipv4: { ip: null } },
          },
        });
      });

    const provider = new HetznerProvider('test-token');
    await provider.provision(provisionOpts);

    expect(capturedBody).not.toBeNull();
    const userData = capturedBody!['user_data'] as string;

    expect(userData).not.toContain('DATABASE_URL');
    expect(userData).not.toContain('ANTHROPIC_API_KEY');
    expect(userData).not.toContain('GH_TOKEN');
    expect(userData).not.toContain('SUPABASE_SERVICE_KEY');
    expect(userData).not.toContain('HETZNER_API_TOKEN');

    // Should contain the allowed vars
    expect(userData).toContain('DOPPLER_TOKEN');
    expect(userData).toContain('PROVISION_SECRET');
    expect(userData).toContain('RESOURCE_ID');
    expect(userData).toContain('AGENT_LIVESTREAM_URL');
  });
});

// ─── createSandboxProvider() tests ───────────────────────────────────────────

describe('createSandboxProvider()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns MockSandboxProvider when NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SANDBOX_PROVIDER;
    delete process.env.HETZNER_API_TOKEN;

    const provider = createSandboxProvider();
    expect(provider).toBeInstanceOf(MockSandboxProvider);
  });

  it('returns MockSandboxProvider when SANDBOX_PROVIDER=mock', () => {
    delete process.env.NODE_ENV;
    process.env.SANDBOX_PROVIDER = 'mock';
    delete process.env.HETZNER_API_TOKEN;

    const provider = createSandboxProvider();
    expect(provider).toBeInstanceOf(MockSandboxProvider);
  });

  it('throws when SANDBOX_PROVIDER=hetzner but HETZNER_API_TOKEN not set', () => {
    delete process.env.NODE_ENV;
    process.env.SANDBOX_PROVIDER = 'hetzner';
    delete process.env.HETZNER_API_TOKEN;

    expect(() => createSandboxProvider()).toThrow('HETZNER_API_TOKEN');
  });
});
