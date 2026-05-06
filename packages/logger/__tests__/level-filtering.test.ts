import {
  log,
  setMinLevel,
  _resetMinLevel,
  registerDrain,
  _resetDrains,
  type DrainAdapter,
} from '../src/index.js'

afterEach(() => {
  _resetDrains()
  _resetMinLevel()
})

describe('minLevel filtering', () => {
  it('(a) drops entries below minLevel — they never reach any drain', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)
    setMinLevel('warn')
    log('debug', 'svc', 'should be dropped')
    log('info', 'svc', 'also dropped')
    await new Promise(resolve => setImmediate(resolve))
    expect(mockDrain.write).not.toHaveBeenCalled()
  })

  it('(b) passes entries at or above minLevel to drains', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)
    setMinLevel('warn')
    log('warn', 'svc', 'at threshold')
    log('error', 'svc', 'above threshold')
    log('fatal', 'svc', 'way above threshold')
    await new Promise(resolve => setImmediate(resolve))
    expect(mockDrain.write).toHaveBeenCalledTimes(3)
  })

  it('(c) setMinLevel takes effect immediately', async () => {
    const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
    registerDrain(mockDrain)

    // Start at debug — info should pass
    setMinLevel('debug')
    log('info', 'svc', 'should pass')
    await new Promise(resolve => setImmediate(resolve))
    expect(mockDrain.write).toHaveBeenCalledTimes(1)

    // Raise to error — info should now be dropped
    setMinLevel('error')
    log('info', 'svc', 'should be dropped now')
    await new Promise(resolve => setImmediate(resolve))
    expect(mockDrain.write).toHaveBeenCalledTimes(1) // no new call

    // error itself should pass
    log('error', 'svc', 'passes at new level')
    await new Promise(resolve => setImmediate(resolve))
    expect(mockDrain.write).toHaveBeenCalledTimes(2)
  })

  it('(d) env-var LOG_LEVEL drives the default when set to a valid level', async () => {
    const savedLogLevel = process.env['LOG_LEVEL']
    const savedNodeEnv = process.env['NODE_ENV']
    try {
      process.env['LOG_LEVEL'] = 'error'
      delete process.env['NODE_ENV']
      _resetMinLevel()

      const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
      registerDrain(mockDrain)

      log('warn', 'svc', 'below error — should be filtered')
      await new Promise(resolve => setImmediate(resolve))
      expect(mockDrain.write).not.toHaveBeenCalled()

      log('error', 'svc', 'at error — should pass')
      await new Promise(resolve => setImmediate(resolve))
      expect(mockDrain.write).toHaveBeenCalledTimes(1)
    } finally {
      if (savedLogLevel === undefined) {
        delete process.env['LOG_LEVEL']
      } else {
        process.env['LOG_LEVEL'] = savedLogLevel
      }
      if (savedNodeEnv === undefined) {
        delete process.env['NODE_ENV']
      } else {
        process.env['NODE_ENV'] = savedNodeEnv
      }
    }
  })

  it('(d) defaults to "info" in production when LOG_LEVEL is unset', async () => {
    const savedLogLevel = process.env['LOG_LEVEL']
    const savedNodeEnv = process.env['NODE_ENV']
    try {
      delete process.env['LOG_LEVEL']
      process.env['NODE_ENV'] = 'production'
      _resetMinLevel()

      const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
      registerDrain(mockDrain)

      log('debug', 'svc', 'debug below info — should be filtered in production')
      await new Promise(resolve => setImmediate(resolve))
      expect(mockDrain.write).not.toHaveBeenCalled()

      log('info', 'svc', 'info at threshold — should pass')
      await new Promise(resolve => setImmediate(resolve))
      expect(mockDrain.write).toHaveBeenCalledTimes(1)
    } finally {
      if (savedLogLevel === undefined) {
        delete process.env['LOG_LEVEL']
      } else {
        process.env['LOG_LEVEL'] = savedLogLevel
      }
      if (savedNodeEnv === undefined) {
        delete process.env['NODE_ENV']
      } else {
        process.env['NODE_ENV'] = savedNodeEnv
      }
    }
  })

  it('(d) defaults to "debug" in non-production when LOG_LEVEL is unset', async () => {
    const savedLogLevel = process.env['LOG_LEVEL']
    const savedNodeEnv = process.env['NODE_ENV']
    try {
      delete process.env['LOG_LEVEL']
      process.env['NODE_ENV'] = 'test'
      _resetMinLevel()

      const mockDrain: DrainAdapter = { write: vi.fn().mockResolvedValue(undefined) }
      registerDrain(mockDrain)

      log('debug', 'svc', 'debug should pass in non-production')
      await new Promise(resolve => setImmediate(resolve))
      expect(mockDrain.write).toHaveBeenCalledTimes(1)
    } finally {
      if (savedLogLevel === undefined) {
        delete process.env['LOG_LEVEL']
      } else {
        process.env['LOG_LEVEL'] = savedLogLevel
      }
      if (savedNodeEnv === undefined) {
        delete process.env['NODE_ENV']
      } else {
        process.env['NODE_ENV'] = savedNodeEnv
      }
    }
  })
})
