export const VALID_TYPES = ['data', 'identity', 'url', 'credential', 'config', 'app', 'skill', 'proxy', 'server', 'database', 'deployment', 'bucket', 'cron', 'flow', 'package', 'service'] as const
export type ResourceTypeName = typeof VALID_TYPES[number]

export const VALID_STATUSES = ['active', 'inactive', 'banned', 'expired', 'error'] as const
export type ResourceStatus = typeof VALID_STATUSES[number]


