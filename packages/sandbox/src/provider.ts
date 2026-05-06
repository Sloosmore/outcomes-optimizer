export interface ProvisionOptions {
  resourceId: string;       // ontology server resource ID
  serverName: string;       // name for the Hetzner server
  publicKey: string;        // SSH public key (ed25519)
  sshKeyName: string;       // name to register the SSH key as
  dopplerToken: string;     // scoped Doppler service token
  provisionSecret: string;  // PROVISION_SECRET for callback auth
  agentLivestreamUrl: string;  // URL for /sandbox/ready callback
  bootstrapScript: string;  // base64-encoded bootstrap.sh content
}

export interface ProvisionResult {
  hetznerServerId: string;
  status: 'provisioning';
  /** IPv4 address assigned at creation time; present when the Hetzner API includes it. */
  ip?: string;
}

export type ServerStatus = 'provisioning' | 'active' | 'error' | 'off';

export interface ServerStatusResult {
  hetznerServerId: string;
  status: ServerStatus;
  ip?: string;
}

export interface SandboxProvider {
  provision(opts: ProvisionOptions): Promise<ProvisionResult>;
  getStatus(hetznerServerId: string): Promise<ServerStatusResult>;
  deprovision(hetznerServerId: string, sshKeyName?: string): Promise<void>;
  /** Resolve a server ID by name; returns null if no server with that name exists. */
  findServerIdByName(serverName: string): Promise<string | null>;
}
