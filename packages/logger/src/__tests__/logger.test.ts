/**
 * Unit tests for @skill-networks/logger
 * All DB calls are mocked via injected deps — no real database connection.
 */

import {
  log,
  createLogger,
  DatabaseDrain,
  registerDrain,
  _resetDrains,
  ConsoleDrain,
  type DrainAdapter,
  type LogEntry,
  type DatabaseDrainDeps,
} from '../index.js'

afterEach(() => {
  _resetDrains()
})

describe('log()', () => {
  it('does not throw even if called with data', () => {
    expect(() => {
      log('info', 'test-svc', 'hello', { key: 'val' })
    }).not.toThrow()
  })

  it('does not throw without data', () => {
    expect(() => {
      log('warn', 'test-svc', 'something happened')
    }).not.toThrow()
  })

  it('supports all log levels including fatal', () => {
    expect(() => {
      log('debug', 'svc', 'debug msg')
      log('info', 'svc', 'info msg')
      log('warn', 'svc', 'warn msg')
      log('error', 'svc', 'error msg')
      log('fatal', 'svc', 'fatal msg')
    }).not.toThrow()
  })
})

describe('createLogger()', () => {
  it('returns a logger bound to the service name', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const logger = createLogger('test-svc')
    logger.info('hello')

    await new Promise((resolve) => setImmediate(resolve))

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test-svc'))
    stdoutSpy.mockRestore()
  })

  it('error() extracts Error object into error field', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const logger = createLogger('test-svc')
    const err = new Error('something broke')
    expect(() => logger.error('an error occurred', err)).not.toThrow()

    await new Promise((resolve) => setImmediate(resolve))
    stdoutSpy.mockRestore()
  })

  it('fatal() does not throw', () => {
    expect(() => {
      const logger = createLogger('test-svc')
      logger.fatal('catastrophic failure')
    }).not.toThrow()
  })

  it('warn() with data does not throw', () => {
    expect(() => {
      const logger = createLogger('svc')
      logger.warn('msg', { key: 'val' })
    }).not.toThrow()
  })

  it('has all expected methods', () => {
    const logger = createLogger('svc')
    expect(logger).toHaveProperty('debug')
    expect(logger).toHaveProperty('info')
    expect(logger).toHaveProperty('warn')
    expect(logger).toHaveProperty('error')
    expect(logger).toHaveProperty('fatal')
  })
})

describe('DatabaseDrain', () => {
  function makeDeps(overrides?: Partial<DatabaseDrainDeps>): DatabaseDrainDeps {
    return {
      getDb: vi.fn(),
      isDatabaseEnabled: vi.fn().mockReturnValue(false),
      logsTable: {},
      ...overrides,
    }
  }

  it('skips write when isDatabaseEnabled() returns false', async () => {
    const deps = makeDeps({ isDatabaseEnabled: vi.fn().mockReturnValue(false) })
    const drain = new DatabaseDrain(deps)

    await drain.write({
      level: 'info',
      service: 'test-svc',
      message: 'hello',
      timestamp: new Date(),
    })

    expect(deps.getDb).not.toHaveBeenCalled()
  })

  it('calls db.insert when isDatabaseEnabled() returns true', async () => {
    const mockValues = vi.fn().mockResolvedValue(undefined)
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues })
    const deps = makeDeps({
      isDatabaseEnabled: vi.fn().mockReturnValue(true),
      getDb: vi.fn().mockReturnValue({ insert: mockInsert }),
    })

    const drain = new DatabaseDrain(deps)
    const entry: LogEntry = {
      level: 'warn',
      service: 'test-svc',
      message: 'something happened',
      timestamp: new Date(),
    }
    await drain.write(entry)

    expect(deps.getDb).toHaveBeenCalled()
    expect(mockInsert).toHaveBeenCalled()
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'something happened' })
    )
  })

  it('logs to stderr when db.insert throws', async () => {
    const deps = makeDeps({
      isDatabaseEnabled: vi.fn().mockReturnValue(true),
      getDb: vi.fn().mockReturnValue({
        insert: () => ({ values: () => { throw new Error('db down') } }),
      }),
    })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const drain = new DatabaseDrain(deps)
    await drain.write({ level: 'error', service: 'svc', message: 'fail', timestamp: new Date() })

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[DatabaseDrain]'))
    stderrSpy.mockRestore()
  })

  it('accepts fatal log level', async () => {
    const mockValues = vi.fn().mockResolvedValue(undefined)
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues })
    const deps = makeDeps({
      isDatabaseEnabled: vi.fn().mockReturnValue(true),
      getDb: vi.fn().mockReturnValue({ insert: mockInsert }),
    })

    const drain = new DatabaseDrain(deps)
    await drain.write({ level: 'fatal', service: 'svc', message: 'fatal error', timestamp: new Date() })

    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ level: 'fatal' }))
  })

  it('satisfies DrainAdapter interface', () => {
    const deps = makeDeps()
    const drain: DrainAdapter = new DatabaseDrain(deps)
    expect(typeof drain.write).toBe('function')
  })
})

describe('registerDrain()', () => {
  it('registered drain receives log entries', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)

    log('info', 'test', 'hello')
    await new Promise((resolve) => setImmediate(resolve))

    expect(mockDrain.write).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', service: 'test', message: 'hello' })
    )
  })

  it('does not register the same drain twice (idempotent)', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)
    registerDrain(mockDrain)

    log('info', 'test', 'hello')
    await new Promise((resolve) => setImmediate(resolve))

    // ConsoleDrain (default) + mockDrain = 2 calls total, not 3
    expect(mockDrain.write).toHaveBeenCalledTimes(1)
  })
})
