import { HetznerProvider } from './hetzner.js';
import { MockSandboxProvider } from './mock.js';
import type { SandboxProvider } from './provider.js';

export type { SandboxProvider, ProvisionOptions, ProvisionResult, ServerStatus, ServerStatusResult } from './provider.js';
export { HetznerProvider } from './hetzner.js';
export { MockSandboxProvider } from './mock.js';
export type { SourceControlProvider } from './scm/index.js';
export { GitHubAppAdapter } from './scm/index.js';
export { PublicAdapter } from './scm/index.js';

export function createSandboxProvider(): SandboxProvider {
  const provider = process.env.SANDBOX_PROVIDER;
  const nodeEnv = process.env.NODE_ENV;

  if (nodeEnv === 'test' || provider === 'mock') {
    return new MockSandboxProvider();
  }

  const apiToken = process.env.HETZNER_API_TOKEN;
  if (!apiToken) {
    throw new Error('HETZNER_API_TOKEN env var required for HetznerProvider');
  }
  return new HetznerProvider(apiToken);
}
