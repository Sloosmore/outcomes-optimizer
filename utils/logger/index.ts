export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  service: string
  message: string
  timestamp: Date
  data?: Record<string, unknown> | null
  error?: { message: string; stack?: string; code?: string } | null
}

export type LogExtra = Partial<Omit<LogEntry, 'level' | 'service' | 'message' | 'timestamp'>>

export interface Logger {
  debug: (msg: string, extra?: LogExtra) => void
  info:  (msg: string, extra?: LogExtra) => void
  warn:  (msg: string, extra?: LogExtra) => void
  error: (msg: string, extra?: LogExtra) => void
}

export interface DrainAdapter {
  write(entry: LogEntry): Promise<void>
}

export class ConsoleDrain implements DrainAdapter {
  async write(entry: LogEntry): Promise<void> {
    process.stderr.write(JSON.stringify(entry) + '\n')
  }
}

// Module-level default drains
const defaultDrains: DrainAdapter[] = [new ConsoleDrain()]

export function registerDrain(drain: DrainAdapter): void {
  if (!defaultDrains.includes(drain)) {
    defaultDrains.push(drain)
  }
}

export function _resetDrains(): void {
  defaultDrains.length = 0
  defaultDrains.push(new ConsoleDrain())
}

export function log(
  level: LogLevel,
  service: string,
  message: string,
  extra?: LogExtra
): void {
  const entry: LogEntry = {
    level,
    service,
    message,
    timestamp: new Date(),
    ...extra,
  }

  const snapshot = [...defaultDrains]
  for (const drain of snapshot) {
    drain.write(entry).catch((err) => {
      process.stderr.write(`[logger] Drain error: ${String(err)}\n`)
    })
  }
}

export function createLogger(service: string): Logger {
  function logWith(level: LogLevel, msg: string, extra?: LogExtra) {
    log(level, service, msg, extra)
  }

  return {
    debug: (msg: string, extra?: LogExtra) => logWith('debug', msg, extra),
    info:  (msg: string, extra?: LogExtra) => logWith('info', msg, extra),
    warn:  (msg: string, extra?: LogExtra) => logWith('warn', msg, extra),
    error: (msg: string, extra?: LogExtra) => logWith('error', msg, extra),
  }
}
