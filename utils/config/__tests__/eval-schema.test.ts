import { loadConfig } from '../index.js'
import { evalDataSchema, evalSchema } from '../schema.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('evalDataSchema', () => {
  it('validates cloud type with training_set', () => {
    const result = evalDataSchema.safeParse({
      type: 'cloud',
      training_set: 'my-training-set',
    })
    expect(result.success).toBe(true)
  })

  it('validates cloud type without training_set (deferred to evalSchema)', () => {
    const result = evalDataSchema.safeParse({
      type: 'cloud',
    })
    expect(result.success).toBe(true)
  })

  it('validates local type with local_path', () => {
    const result = evalDataSchema.safeParse({
      type: 'local',
      local_path: './data/',
    })
    expect(result.success).toBe(true)
  })

  it('rejects local type without local_path', () => {
    const result = evalDataSchema.safeParse({
      type: 'local',
    })
    expect(result.success).toBe(false)
  })

  it('validates none type', () => {
    const result = evalDataSchema.safeParse({
      type: 'none',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid type', () => {
    const result = evalDataSchema.safeParse({
      type: 'invalid',
    })
    expect(result.success).toBe(false)
  })
})

describe('evalSchema', () => {
  it('validates complete eval config', () => {
    const result = evalSchema.safeParse({
      data: { type: 'cloud', training_set: 'test-set' },
      loop: { enabled: true, max_epochs: 5 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data?.loop?.enabled).toBe(true)
      expect(result.data?.loop?.max_epochs).toBe(5)
    }
  })

  it('accepts cloud eval config with run_name and no training_set', () => {
    const result = evalSchema.safeParse({
      run_name: 'powerpoint-to-html-v1.2',
      data: { type: 'cloud' },
      loop: { enabled: true, max_epochs: 5 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects cloud eval config without run_name or training_set', () => {
    const result = evalSchema.safeParse({
      data: { type: 'cloud' },
      loop: { enabled: true, max_epochs: 5 },
    })
    expect(result.success).toBe(false)
  })

  it('validates eval config with only data', () => {
    const result = evalSchema.safeParse({
      data: { type: 'none' },
    })
    expect(result.success).toBe(true)
  })

  it('applies defaults for loop', () => {
    const result = evalSchema.safeParse({
      data: { type: 'none' },
      loop: {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data?.loop?.enabled).toBe(false)
      expect(result.data?.loop?.max_epochs).toBe(10)
    }
  })

  it('rejects invalid loop max_epochs', () => {
    const result = evalSchema.safeParse({
      data: { type: 'none' },
      loop: { enabled: true, max_epochs: -1 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer loop max_epochs', () => {
    const result = evalSchema.safeParse({
      data: { type: 'none' },
      loop: { enabled: true, max_epochs: 4.5 },
    })
    expect(result.success).toBe(false)
  })
})

describe('loadConfig with eval section', () => {
  const testDir = join(tmpdir(), 'skill-networks-eval-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('loads config with cloud eval', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
eval:
  data:
    type: cloud
    training_set: image-to-html-v1
  loop:
    enabled: true
    max_epochs: 5
`)

    const config = loadConfig(configPath)

    expect(config.eval).toBeDefined()
    expect(config.eval?.data.type).toBe('cloud')
    if (config.eval?.data.type === 'cloud') {
      expect(config.eval.data.training_set).toBe('image-to-html-v1')
    }
    expect(config.eval?.loop?.enabled).toBe(true)
    expect(config.eval?.loop?.max_epochs).toBe(5)
  })

  it('loads config with cloud eval run_name', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
eval:
  run_name: powerpoint-to-html-v1.2
  data:
    type: cloud
  loop:
    enabled: true
    max_epochs: 5
`)

    const config = loadConfig(configPath)

    expect(config.eval).toBeDefined()
    expect(config.eval?.run_name).toBe('powerpoint-to-html-v1.2')
    expect(config.eval?.data.type).toBe('cloud')
    expect(config.eval?.loop?.enabled).toBe(true)
    expect(config.eval?.loop?.max_epochs).toBe(5)
  })

  it('loads config with local eval', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
eval:
  data:
    type: local
    local_path: ./data/
`)

    const config = loadConfig(configPath)

    expect(config.eval?.data.type).toBe('local')
    if (config.eval?.data.type === 'local') {
      expect(config.eval.data.local_path).toBe('./data/')
    }
  })

  it('loads config with none eval', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
eval:
  data:
    type: none
`)

    const config = loadConfig(configPath)

    expect(config.eval?.data.type).toBe('none')
  })

  it('loads config without eval section', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
`)

    const config = loadConfig(configPath)

    expect(config.eval).toBeUndefined()
  })

  it('rejects invalid eval data type', () => {
    const configPath = join(testDir, 'config.yaml')
    writeFileSync(configPath, `
campaign:
  name: test
database:
  adapter: none
cli:
  adapter: mock
eval:
  data:
    type: s3
`)

    expect(() => loadConfig(configPath)).toThrow('Invalid config')
  })
})
