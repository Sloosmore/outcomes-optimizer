export interface CloudflaredConfigOptions {
  serverId: string
  tunnelId: string
  credentialsFilePath?: string
  routerPort?: number
}

/**
 * Generate the content of a cloudflared config.yaml for a sandbox VM.
 * Pure function — no side effects, no env reads.
 */
export function generateCloudflaredConfig(opts: CloudflaredConfigOptions): string {
  const credentialsFile = opts.credentialsFilePath ?? '/root/.cloudflared/credentials.json'
  const routerPort = opts.routerPort ?? 8080

  return [
    `tunnel: ${opts.tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    `no-autoupdate: true`,
    ``,
    `ingress:`,
    `  - hostname: "*.${opts.serverId}.example.com"`,
    `    service: http://localhost:${routerPort}`,
    `  - service: http_status:404`,
    ``,
  ].join('\n')
}
