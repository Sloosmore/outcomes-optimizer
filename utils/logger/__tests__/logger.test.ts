import { log, createLogger, ConsoleDrain, registerDrain, _resetDrains, type DrainAdapter, type LogEntry } from '../index.js'

afterEach(() => {
  _resetDrains()
})

describe('ConsoleDrain', () => {
  it('writes JSON to stderr', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const drain = new ConsoleDrain()
    await drain.write({ level: 'info', service: 'svc', message: 'hello', timestamp: new Date() })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"level":"info"'))
    spy.mockRestore()
  })
})

describe('log()', () => {
  it('does not throw', () => {
    expect(() => log('info', 'svc', 'hello')).not.toThrow()
  })

  it('does not throw with extra data', () => {
    expect(() => log('warn', 'svc', 'msg', { data: { key: 'val' } })).not.toThrow()
  })

  it('does not throw when a drain rejects', async () => {
    const brokenDrain: DrainAdapter = { write: async () => { throw new Error('boom') } }
    registerDrain(brokenDrain)
    expect(() => log('error', 'svc', 'fail')).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
  })
})

describe('createLogger()', () => {
  it('returns logger with all methods', () => {
    const logger = createLogger('svc')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('writes to registered drains', async () => {
    const entries: LogEntry[] = []
    const drain: DrainAdapter = { write: async (e) => { entries.push(e) } }
    registerDrain(drain)
    const logger = createLogger('test-svc')
    logger.info('hello')
    await new Promise((resolve) => setImmediate(resolve))
    expect(entries.some(e => e.service === 'test-svc' && e.message === 'hello')).toBe(true)
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

  it('is idempotent — same drain not registered twice', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)
    registerDrain(mockDrain)
    log('info', 'test', 'hello')
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockDrain.write).toHaveBeenCalledTimes(1)
  })
})
