import { parseArgs } from '../parseArgs.js'

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const result = parseArgs(['--name', 'test', '--count', '5'])

    expect(result.name).toBe('test')
    expect(result.count).toBe('5')
  })

  it('handles kebab-case keys', () => {
    const result = parseArgs(['--training-set', 'my-set', '--max-epochs', '10'])

    expect(result['training-set']).toBe('my-set')
    expect(result['max-epochs']).toBe('10')
  })

  it('handles flags without values', () => {
    const result = parseArgs(['--verbose', '--debug'])

    expect(result.verbose).toBe('true')
    expect(result.debug).toBe('true')
  })

  it('handles mixed flags and key-value pairs', () => {
    const result = parseArgs(['--verbose', '--name', 'test', '--debug'])

    expect(result.verbose).toBe('true')
    expect(result.name).toBe('test')
    expect(result.debug).toBe('true')
  })

  it('returns empty object for no args', () => {
    const result = parseArgs([])

    expect(result).toEqual({})
  })

  it('ignores positional arguments', () => {
    const result = parseArgs(['positional', '--name', 'test', 'another'])

    expect(result.name).toBe('test')
    expect(result.positional).toBeUndefined()
    expect(result.another).toBeUndefined()
  })

  it('stops value capture at next flag', () => {
    const result = parseArgs(['--flag1', '--flag2', 'value'])

    expect(result.flag1).toBe('true')
    expect(result.flag2).toBe('value')
  })
})
