/**
 * Unit tests for resources CLI helpers
 * Tests pure functions only — no database connection required
 */
import { parseArgs, parseJsonArg, VALID_TYPES, VALID_STATUSES } from '../resource-helpers.js'

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    expect(parseArgs(['--name', 'foo', '--type', 'identity'])).toEqual({ name: 'foo', type: 'identity' })
  })

  it('parses --key=value syntax', () => {
    expect(parseArgs(['--name=foo', '--type=identity'])).toEqual({ name: 'foo', type: 'identity' })
  })

  it('sets boolean true for flags with no value', () => {
    expect(parseArgs(['--verbose'])).toEqual({ verbose: 'true' })
  })

  it('sets boolean true when next arg is another flag', () => {
    expect(parseArgs(['--verbose', '--name', 'foo'])).toEqual({ verbose: 'true', name: 'foo' })
  })

  it('handles empty args', () => {
    expect(parseArgs([])).toEqual({})
  })

  it('ignores positional args (no leading --)', () => {
    expect(parseArgs(['add', '--name', 'foo'])).toEqual({ name: 'foo' })
  })

  it('handles --key= with empty value', () => {
    expect(parseArgs(['--name='])).toEqual({ name: '' })
  })

  it('last flag with no following value becomes true', () => {
    expect(parseArgs(['--name', 'foo', '--flag'])).toEqual({ name: 'foo', flag: 'true' })
  })
})

describe('parseJsonArg', () => {
  it('parses a valid JSON object', () => {
    expect(parseJsonArg('{"platform":"instagram"}', 'config')).toEqual({ platform: 'instagram' })
  })

  it('parses an empty JSON object', () => {
    expect(parseJsonArg('{}', 'config')).toEqual({})
  })

  it('throws for malformed JSON', () => {
    expect(() => parseJsonArg('{invalid}', 'config')).toThrow('--config is not valid JSON')
  })

  it('throws for JSON string (not object)', () => {
    expect(() => parseJsonArg('"just a string"', 'config')).toThrow('--config must be a JSON object, got string')
  })

  it('throws for JSON boolean', () => {
    expect(() => parseJsonArg('true', 'config')).toThrow('--config must be a JSON object, got boolean')
  })

  it('throws for JSON number', () => {
    expect(() => parseJsonArg('42', 'config')).toThrow('--config must be a JSON object, got number')
  })

  it('throws for JSON array', () => {
    expect(() => parseJsonArg('[1,2,3]', 'config')).toThrow('--config must be a JSON object, got array')
  })

  it('throws for JSON null with clear message', () => {
    expect(() => parseJsonArg('null', 'config')).toThrow('--config must be a JSON object, got null')
  })

  it('includes argName in error message', () => {
    expect(() => parseJsonArg('bad', 'myFlag')).toThrow('--myFlag is not valid JSON')
  })
})

describe('VALID_TYPES', () => {
  it('contains all documented types', () => {
    expect([...VALID_TYPES]).toEqual(['data', 'identity', 'url', 'credential', 'config', 'app', 'skill', 'proxy', 'server', 'database', 'deployment', 'bucket', 'cron'])
  })

  it('rejects unknown types', () => {
    expect(VALID_TYPES.includes('banana' as typeof VALID_TYPES[number])).toBe(false)
  })

  it('rejects empty string', () => {
    expect(VALID_TYPES.includes('' as typeof VALID_TYPES[number])).toBe(false)
  })
})

describe('VALID_STATUSES', () => {
  it('contains all documented statuses', () => {
    expect([...VALID_STATUSES]).toEqual(['active', 'inactive', 'banned', 'expired', 'error'])
  })

  it('rejects unknown statuses', () => {
    expect(VALID_STATUSES.includes('deleted' as typeof VALID_STATUSES[number])).toBe(false)
  })

  it('rejects empty string', () => {
    expect(VALID_STATUSES.includes('' as typeof VALID_STATUSES[number])).toBe(false)
  })
})
