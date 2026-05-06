import type { SandboxProvider, ProvisionOptions, ProvisionResult, ServerStatusResult, ServerStatus } from './provider.js';

interface HetznerSshKeyResponse {
  ssh_key: {
    id: number;
    name: string;
  };
}

interface HetznerSshKeyListResponse {
  ssh_keys: Array<{
    id: number;
    name: string;
    public_key: string;
  }>;
  meta?: {
    pagination?: {
      next_page: number | null;
    };
  };
}

interface HetznerServerResponse {
  server: {
    id: number;
    status: string;
    public_net: {
      ipv4: {
        ip: string | null;
      } | null;
    };
  };
}

interface HetznerServerListResponse {
  servers: Array<{
    id: number;
    name: string;
    status: string;
    public_net: {
      ipv4: {
        ip: string | null;
      } | null;
    };
  }>;
}

/** Strip SSH key comment field — Hetzner stores only key-type + base64 (no comment). */
const stripSshComment = (pk: string) => pk.trim().split(/\s+/).slice(0, 2).join(' ')

function mapHetznerStatus(hetznerStatus: string): ServerStatus {
  switch (hetznerStatus) {
    case 'running':
      return 'active';
    case 'initializing':
    case 'starting':
    case 'stopping':
      return 'provisioning';
    case 'off':
      return 'off';
    default:
      return 'error';
  }
}

const SSH_KEY_PAGE_SIZE = 50;

function httpError(msg: string, result: { status: number; rawBody?: string }): Error {
  const body = result.rawBody ? ` — body: ${result.rawBody}` : '';
  return new Error(`${msg}: HTTP ${result.status}${body}`);
}

export class HetznerProvider implements SandboxProvider {
  private apiToken: string;
  private baseUrl = 'https://api.hetzner.cloud/v1';

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T; rawBody?: string }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data: T;
    try {
      data = (text.trim() ? JSON.parse(text) : {}) as T;
    } catch {
      // Surface the raw body so callers can include it in error messages
      return { status: response.status, data: {} as T, rawBody: text.slice(0, 500) };
    }
    // Also surface the body for non-2xx responses so httpError() can include structured API errors
    const rawBody = response.status >= 400 ? text.slice(0, 500) : undefined;
    return { status: response.status, data, rawBody };
  }

  async provision(opts: ProvisionOptions): Promise<ProvisionResult> {
    // Step 1: Register SSH key (handle 409/422 conflict by deleting stale key and re-creating)
    const sshKeyResult = await this.request<HetznerSshKeyResponse>('POST', '/ssh_keys', {
      name: opts.sshKeyName,
      public_key: opts.publicKey,
    });

    if (sshKeyResult.status === 409 || sshKeyResult.status === 422) {
      // Name or public_key conflict — delete the stale key and re-create
      // so the VM always gets the freshly generated public key.
      // NOTE: This assumes exclusive control of the Hetzner project's SSH key namespace.
      // If this provisioner ever shares a Hetzner project with other systems, replace
      // the delete-and-recreate with unique-per-provision key names.
      // Concurrency note: two provisioners running simultaneously against the same Hetzner project
      // may race between SSH key creation and server creation. This is acceptable only
      // under the exclusive-control assumption above.
      const listByName = await this.request<HetznerSshKeyListResponse>('GET', `/ssh_keys?name=${encodeURIComponent(opts.sshKeyName)}`);
      if (listByName.status !== 200) {
        throw httpError('Failed to list SSH keys by name', listByName);
      }
      if (listByName.data.ssh_keys.length > 0) {
        const keyId = listByName.data.ssh_keys[0].id;
        if (typeof keyId !== 'number') throw new Error(`Invalid SSH key id: ${keyId}`);
        const delResult = await this.request<unknown>('DELETE', `/ssh_keys/${keyId}`);
        // 404 = already deleted by a concurrent provisioner; treat as success
        if (delResult.status !== 204 && delResult.status !== 200 && delResult.status !== 404) {
          throw httpError(`Failed to delete stale SSH key ${keyId}`, delResult);
        }
      } else {
        // Public key registered under a different name — find and delete it (paginated)
        // Normalize to key-type + base64 only (strip comment); Hetzner strips comments when storing
        const normalizedPublicKey = stripSshComment(opts.publicKey);
        let match: { id: number; name: string; public_key: string } | undefined;
        let page = 1;
        const MAX_SSH_KEY_PAGES = 100; // 5000 keys at per_page=50
        // seenPages is defense-in-depth: guards against Hetzner returning a cyclic next_page.
        // The iterations < MAX_SSH_KEY_PAGES ceiling already bounds the loop; seenPages ensures
        // we stop immediately if the API ever returns a page number we've already visited.
        const seenPages = new Set<number>();
        let iterations = 0;
        while (!match && iterations < MAX_SSH_KEY_PAGES) {
          iterations++;
          seenPages.add(page);
          const listPage = await this.request<HetznerSshKeyListResponse>('GET', `/ssh_keys?per_page=${SSH_KEY_PAGE_SIZE}&page=${page}`);
          if (listPage.status !== 200) {
            throw httpError('Failed to list SSH keys (paginated)', listPage);
          }
          match = listPage.data.ssh_keys.find(k => stripSshComment(k.public_key) === normalizedPublicKey);
          // ?? (not ||) so that an explicit next_page: null from Hetzner propagates correctly
          // (null ?? fallback = fallback, whereas null || fallback = fallback too — but
          // next_page: 0 would be falsy under || yet valid under ?? for a page-0 edge case).
          const nextPage = listPage.data.meta?.pagination?.next_page
            ?? (listPage.data.ssh_keys.length === SSH_KEY_PAGE_SIZE ? page + 1 : null);
          if (!nextPage || seenPages.has(nextPage)) break;
          page = nextPage;
        }
        if (!match) {
          throw new Error(`SSH key conflict but key not found: ${opts.sshKeyName}`);
        }
        if (typeof match.id !== 'number') throw new Error(`Invalid SSH key id: ${match.id}`);
        const delResult = await this.request<unknown>('DELETE', `/ssh_keys/${match.id}`);
        // 404 = already deleted by a concurrent provisioner; treat as success
        if (delResult.status !== 204 && delResult.status !== 200 && delResult.status !== 404) {
          throw httpError(`Failed to delete stale SSH key ${match.id}`, delResult);
        }
      }
      // Re-create with the current public key
      const retryResult = await this.request<HetznerSshKeyResponse>('POST', '/ssh_keys', {
        name: opts.sshKeyName,
        public_key: opts.publicKey,
      });
      if (retryResult.status === 409 || retryResult.status === 422) {
        // A concurrent provisioner may have already re-created the key; verify it matches
        const verifyList = await this.request<HetznerSshKeyListResponse>('GET', `/ssh_keys?name=${encodeURIComponent(opts.sshKeyName)}`);
        if (verifyList.status !== 200) {
          throw httpError('Failed to verify SSH key after conflict retry', verifyList);
        }
        const existing = verifyList.data.ssh_keys[0];
        // Compare without comment — Hetzner strips comments when storing
        if (!existing || stripSshComment(existing.public_key) !== stripSshComment(opts.publicKey)) {
          throw new Error('SSH key name held by different public key after conflict retry — manual intervention required');
        }
        // Existing key matches desired public key — proceed
      } else if (retryResult.status !== 201) {
        throw httpError('Failed to re-create SSH key after conflict', retryResult);
      }
    } else if (sshKeyResult.status !== 201) {
      throw httpError('Failed to create SSH key', sshKeyResult);
    }

    // Step 2: Decode bootstrap script and build user_data
    let bootstrapContent = '';
    if (opts.bootstrapScript) {
      bootstrapContent = Buffer.from(opts.bootstrapScript, 'base64').toString('utf-8');
    }

    const userData = [
      '#!/bin/bash',
      `export DOPPLER_TOKEN="${opts.dopplerToken}"`,
      `export PROVISION_SECRET="${opts.provisionSecret}"`,
      `export RESOURCE_ID="${opts.resourceId}"`,
      `export AGENT_LIVESTREAM_URL="${opts.agentLivestreamUrl}"`,
      `export RUNTIME_IMAGE="${process.env['RUNTIME_IMAGE'] ?? 'build:local'}"`,
      bootstrapContent,
    ].join('\n');

    // Step 3: Create the server
    const serverResult = await this.request<HetznerServerResponse>('POST', '/servers', {
      name: opts.serverName,
      server_type: 'cx23',
      image: 'ubuntu-24.04',
      location: 'hel1',
      ssh_keys: [opts.sshKeyName],
      user_data: userData,
    });

    if (serverResult.status !== 201) {
      throw httpError('Failed to create server', serverResult);
    }

    const provisionedIp = serverResult.data.server.public_net.ipv4?.ip ?? undefined;
    return {
      hetznerServerId: serverResult.data.server.id.toString(),
      status: 'provisioning',
      ...(provisionedIp ? { ip: provisionedIp } : {}),
    };
  }

  async getStatus(hetznerServerId: string): Promise<ServerStatusResult> {
    if (!/^\d+$/.test(hetznerServerId)) throw new Error(`Invalid Hetzner server ID: ${hetznerServerId}`)
    const result = await this.request<HetznerServerResponse>('GET', `/servers/${hetznerServerId}`);

    if (result.status !== 200) {
      throw httpError('Failed to get server status', result);
    }

    const server = result.data.server;
    const status = mapHetznerStatus(server.status);
    const ip = server.public_net.ipv4?.ip ?? undefined;

    return {
      hetznerServerId,
      status,
      ...(ip ? { ip } : {}),
    };
  }

  async deprovision(hetznerServerId: string, sshKeyName?: string): Promise<void> {
    if (!/^\d+$/.test(hetznerServerId)) throw new Error(`Invalid Hetzner server ID: ${hetznerServerId}`)
    const result = await this.request<unknown>('DELETE', `/servers/${hetznerServerId}`);

    // 404 = already deleted (idempotent deprovisioning); treat as success
    if (result.status !== 200 && result.status !== 204 && result.status !== 404) {
      throw httpError('Failed to deprovision server', result);
    }

    // Clean up the SSH key associated with this sandbox so it doesn't accumulate
    // across sequential provisions (re-provisioning the same user's sandbox would
    // hit a 409/422 conflict and the conflict-resolution path would need to delete
    // the stale key anyway — do it eagerly here instead).
    if (sshKeyName) {
      const listResult = await this.request<HetznerSshKeyListResponse>('GET', `/ssh_keys?name=${encodeURIComponent(sshKeyName)}`);
      if (listResult.status === 200 && listResult.data.ssh_keys.length > 0) {
        const keyId = listResult.data.ssh_keys[0].id;
        if (typeof keyId === 'number') {
          const delResult = await this.request<unknown>('DELETE', `/ssh_keys/${keyId}`);
          // 404 = already deleted; treat as success
          if (delResult.status !== 204 && delResult.status !== 200 && delResult.status !== 404) {
            throw httpError(`Failed to delete SSH key ${keyId} during deprovision`, delResult);
          }
        }
      }
    }
  }

  async findServerIdByName(serverName: string): Promise<string | null> {
    const result = await this.request<HetznerServerListResponse>(
      'GET',
      `/servers?name=${encodeURIComponent(serverName)}`
    );
    if (result.status !== 200) {
      throw httpError('Failed to find server by name', result);
    }
    const server = result.data.servers[0];
    return server ? server.id.toString() : null;
  }
}
