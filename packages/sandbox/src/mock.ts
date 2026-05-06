import type { SandboxProvider, ProvisionOptions, ProvisionResult, ServerStatusResult } from './provider.js';

export interface MockSandboxProviderOptions {
  failProvision?: boolean;
  provisionDelay?: number;
}

export class MockSandboxProvider implements SandboxProvider {
  private servers: Map<string, { ip: string; name?: string }> = new Map();
  private failProvision: boolean;
  private provisionDelay: number;

  constructor(options: MockSandboxProviderOptions = {}) {
    this.failProvision = options.failProvision ?? false;
    this.provisionDelay = options.provisionDelay ?? 0;
  }

  async provision(_opts: ProvisionOptions): Promise<ProvisionResult> {
    if (this.provisionDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.provisionDelay));
    }

    if (this.failProvision) {
      throw new Error('MockSandboxProvider: provision failed (failProvision=true)');
    }

    const hetznerServerId = `mock-server-${Date.now()}`;
    this.servers.set(hetznerServerId, { ip: '1.2.3.4', name: _opts.serverName });

    return {
      hetznerServerId,
      status: 'provisioning',
      ip: '1.2.3.4',
    };
  }

  async getStatus(hetznerServerId: string): Promise<ServerStatusResult> {
    const server = this.servers.get(hetznerServerId);
    if (!server) {
      throw new Error(`MockSandboxProvider: unknown server ID: ${hetznerServerId}`);
    }

    return {
      hetznerServerId,
      status: 'active',
      ip: server.ip,
    };
  }

  async deprovision(hetznerServerId: string, _sshKeyName?: string): Promise<void> {
    if (!this.servers.has(hetznerServerId)) {
      throw new Error(`MockSandboxProvider: unknown server ID: ${hetznerServerId}`);
    }
    this.servers.delete(hetznerServerId);
  }

  async findServerIdByName(serverName: string): Promise<string | null> {
    for (const [id, server] of this.servers.entries()) {
      if (server.name === serverName) return id;
    }
    return null;
  }
}
