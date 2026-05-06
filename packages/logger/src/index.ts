export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 }

function deriveDefaultMinLevel(): LogLevel {
  const env = process.env['LOG_LEVEL']
  if (env) {
    if (env in LEVEL_ORDER) return env as LogLevel
    process.stderr.write(`[logger] Invalid LOG_LEVEL="${env}". Valid values: ${Object.keys(LEVEL_ORDER).join(', ')}. Falling back to default.\n`)
  }
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug'
}
let _minLevel: LogLevel = deriveDefaultMinLevel()

export function setMinLevel(level: LogLevel): void {
  _minLevel = level
}

export function _resetMinLevel(): void {
  _minLevel = deriveDefaultMinLevel()
}

export interface LogEntry {
  level: LogLevel
  service: string
  message: string
  timestamp: Date
  data?: Record<string, unknown>
  error?: { message: string; stack?: string; code?: string }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, errOrData?: Error | Record<string, unknown>): void
  fatal(message: string, errOrData?: Error | Record<string, unknown>): void
}

export interface DrainAdapter {
  write(entry: LogEntry): Promise<void>
}

export class ConsoleDrain implements DrainAdapter {
  private readonly isDev: boolean
  constructor() { this.isDev = process.env['NODE_ENV'] !== 'production' }
  async write(entry: LogEntry): Promise<void> {
    if (this.isDev) {
      const { level, service, message, timestamp, ...rest } = entry
      const prefix = `[${timestamp.toISOString()}] [${level.toUpperCase()}] [${service}]`
      const extra = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : ''
      process.stdout.write(`${prefix} ${message}${extra}\n`)
    } else {
      process.stdout.write(JSON.stringify(entry) + '\n')
    }
  }
}

/** Dependencies required by DatabaseDrain — injected by the consumer. */
export interface DatabaseDrainDeps {
  getDb: () => { insert: (table: any) => { values: (data: any) => Promise<any> } }
  isDatabaseEnabled: () => boolean
  logsTable: unknown
}

export class DatabaseDrain implements DrainAdapter {
  constructor(private deps: DatabaseDrainDeps) {}

  async write(entry: LogEntry): Promise<void> {
    if (!this.deps.isDatabaseEnabled()) {
      return
    }
    try {
      const db = this.deps.getDb()
      await db.insert(this.deps.logsTable).values({
        level: entry.level,
        service: entry.service,
        message: entry.message,
        timestamp: entry.timestamp,
        data: entry.data,
        error: entry.error,
      })
    } catch (err) {
      process.stderr.write(`[DatabaseDrain] Failed to write log entry: ${String(err)}\n`)
    }
  }
}

// Module-level drain registry — ConsoleDrain always present
const drains: DrainAdapter[] = [new ConsoleDrain()]
let _drainErrorCount = 0
let _drainErrorWindowStart = Date.now()
const DRAIN_ERROR_WINDOW_MS = 300_000 // 5 minutes

/** Register an additional drain (e.g. DatabaseDrain). Call once at startup. Idempotent. */
export function registerDrain(drain: DrainAdapter): void {
  if (drains.includes(drain)) return
  drains.push(drain)
}

/** Reset drains to default (ConsoleDrain only). Exported for test cleanup. */
export function _resetDrains(): void {
  drains.length = 0
  drains.push(new ConsoleDrain())
  _drainErrorCount = 0
  _drainErrorWindowStart = Date.now()
}

function extractError(errOrData?: Error | Record<string, unknown>): {
  errorField?: LogEntry['error']
  dataField?: Record<string, unknown>
} {
  if (errOrData === undefined) return {}
  if (errOrData instanceof Error) {
    return {
      errorField: {
        message: errOrData.message,
        stack: errOrData.stack,
        code: (errOrData as NodeJS.ErrnoException).code,
      },
    }
  }
  return { dataField: errOrData }
}

/**
 * Fire-and-forget log call. Never throws, never rejects.
 * Drain failures are swallowed and written to stderr.
 */
export function log(
  level: LogLevel,
  service: string,
  message: string,
  errOrData?: Error | Record<string, unknown>
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_minLevel]) return
  const { errorField, dataField } = extractError(errOrData)
  const entry: LogEntry = {
    level,
    service,
    message,
    timestamp: new Date(),
    ...(dataField !== undefined ? { data: dataField } : {}),
    ...(errorField !== undefined ? { error: errorField } : {}),
  }

  const snapshot = [...drains]
  for (const drain of snapshot) {
    drain.write(entry).catch((err) => {
      const now = Date.now()
      if (now - _drainErrorWindowStart > DRAIN_ERROR_WINDOW_MS) {
        _drainErrorCount = 0
        _drainErrorWindowStart = now
      }
      _drainErrorCount++
      if (_drainErrorCount === 1 || _drainErrorCount % 100 === 0) {
        process.stderr.write(`[logger] Drain error (count=${_drainErrorCount}): ${String(err)}\n`)
      }
    })
  }
}

/**
 * Returns a logger bound to a fixed service name.
 * Uses module-level registered drains.
 */
export function createLogger(service: string): Logger {
  return {
    debug: (message: string, data?: Record<string, unknown>) => log('debug', service, message, data),
    info:  (message: string, data?: Record<string, unknown>) => log('info', service, message, data),
    warn:  (message: string, data?: Record<string, unknown>) => log('warn', service, message, data),
    error: (message: string, errOrData?: Error | Record<string, unknown>) => log('error', service, message, errOrData),
    fatal: (message: string, errOrData?: Error | Record<string, unknown>) => log('fatal', service, message, errOrData),
  }
}
