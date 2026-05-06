// Mock dispatch module before importing poller
vi.mock('@duoidal/utils/dispatch', () => ({
  validateSkillConfig: vi.fn(),
  dispatchRun: vi.fn(),
}))

import { shouldDispatch } from './poller-service.js'
import { poll, reapStalePending } from './poller'

/**
 * Create a mock sql tagged-template function.
 * postgres sql is called as a tagged template: sql`...`
 * Tagged templates receive (strings[], ...values) args.
 */
function createMockSql(responses: unknown[][]) {
  let callIndex = 0
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = responses[callIndex] ?? []
    callIndex++
    return Promise.resolve(result)
  })
  return fn as unknown as ReturnType<typeof import('postgres')>
}

describe('shouldDispatch', () => {
  it('returns skip when metric exists for today', async () => {
    // Gate 1 returns a row (metric exists)
    const sql = createMockSql([[{ '1': 1 }]])
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day')
    expect(result).toEqual({ skip: true, reason: 'metric failures_per_day already recorded today' })
  })

  it('returns skip when active process exists (no metric match)', async () => {
    // Gate 1: no metric rows; Gate 2: process exists
    const sql = createMockSql([[], [{ '1': 1 }]])
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day')
    expect(result).toEqual({ skip: true, reason: 'active process exists' })
  })

  it('returns skip=false when all gates pass', async () => {
    // Gate 1: no metric rows; Gate 2: no process rows; Gate 3: 0 failures
    const sql = createMockSql([[], [], [{ count: 0 }]])
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day')
    expect(result).toEqual({ skip: false })
  })

  it('returns skip when 3+ failures today with no success (gate 3)', async () => {
    // Gate 1: no metric; Gate 2: no active; Gate 3: 3 failures; no completed today
    const sql = createMockSql([[], [], [{ count: 3 }], []])
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day')
    expect(result).toEqual({ skip: true, reason: '3 failures today with no success — halting until tomorrow' })
  })

  it('returns skip=false when 3+ failures but a completed process exists today', async () => {
    // Gate 1: no metric; Gate 2: no active; Gate 3: 5 failures; but 1 completed today
    const sql = createMockSql([[], [], [{ count: 5 }], [{ '1': 1 }]])
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day')
    expect(result).toEqual({ skip: false })
  })

  it('returns skip=false when metricKey is undefined (gate 1 bypassed)', async () => {
    // Only Gate 2 + Gate 3 run: no process rows, 0 failures
    const sql = createMockSql([[], [{ count: 0 }]])
    const result = await shouldDispatch(sql, 'skill-1', undefined)
    expect(result).toEqual({ skip: false })
  })

  it('returns skip=false when bypassIdempotency is true, even with metric snapshot', async () => {
    // Even though gate 1 would return a row, bypass skips all DB calls
    const sql = createMockSql([]) // no responses needed — should not be called
    const result = await shouldDispatch(sql, 'skill-1', 'failures_per_day', true)
    expect(result).toEqual({ skip: false })
    // SQL should NOT have been called (bypass skips all gates)
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns skip=false when bypassIdempotency is true, even with active process', async () => {
    const sql = createMockSql([])
    const result = await shouldDispatch(sql, 'skill-1', undefined, true)
    expect(result).toEqual({ skip: false })
    expect(sql).not.toHaveBeenCalled()
  })

  it('returns skip when formulaResource=true and completed process exists today', async () => {
    // Gate 1 formula: completed process exists
    const sql = createMockSql([[{ '1': 1 }], []])
    const result = await shouldDispatch(sql, 'skill-1', undefined, false, true)
    expect(result).toEqual({ skip: true, reason: 'process already completed today' })
  })

  it('returns skip=false when formulaResource=true but no completed process today', async () => {
    // Gate 1 formula: no completed process; Gate 2: no active process; Gate 3: 0 failures
    const sql = createMockSql([[], [], [{ count: 0 }]])
    const result = await shouldDispatch(sql, 'skill-1', undefined, false, true)
    expect(result).toEqual({ skip: false })
  })
})

describe('poll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls shouldDispatch for each due cron row', async () => {
    const cronRow = {
      id: 'cron-1',
      name: 'test-cron',
      config: { schedule: '* * * * *', enabled: true, prompt: 'do stuff' },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'test-skill',
      skill_config: { metric: 'failures_per_day', content: 'run the skill' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],            // reapStalePending UPDATE (no stale rows)
      [cronRow],     // main query: cron rows
      [],            // shouldDispatch gate 1: no metric
      [{ '1': 1 }], // shouldDispatch gate 2: active process exists -> skip
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // sql should be called 4 times: reap + main query + 2 gates
    expect(sql).toHaveBeenCalledTimes(4)
    // Should have logged the skip message
    expect(logSpy).toHaveBeenCalledWith('[poller] Skipping test-skill: active process exists')
  })

  it('dispatches and updates process status to completed on success', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const cronRow = {
      id: 'cron-1',
      name: 'test-cron',
      config: { schedule: '* * * * *', enabled: true, prompt: 'do stuff' },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'test-skill',
      skill_config: { metric: 'failures_per_day', content: 'run the skill' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [cronRow],              // main query
      [],                     // gate 1: no metric
      [],                     // gate 2: no active process
      [{ count: 0 }],        // gate 3: 0 failures today (shouldDispatch passes)
      [{ id: 'proc-uuid' }], // atomic INSERT returns new process id
      [],                     // UPDATE status = 'completed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // reap + main + gate1 + gate2 + gate3 + atomic insert + UPDATE completed = 7
    expect(sql).toHaveBeenCalledTimes(7)
    expect(dispatchRunMock).toHaveBeenCalled()
  })

  it('updates process status to failed when dispatch throws', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockRejectedValue(new Error('dispatch error'))

    const cronRow = {
      id: 'cron-1',
      name: 'test-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'test-skill',
      skill_config: { content: 'run the skill' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [cronRow],              // main query
      [],                     // gate 2: no active process (no metricKey, gate 1 skipped)
      [{ count: 0 }],        // gate 3: 0 failures today
      [{ id: 'proc-uuid' }], // atomic INSERT returns new process id
      [],                     // UPDATE status = 'failed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await poll(sql)

    // reap + main + gate2 + gate3 + atomic insert + UPDATE failed = 6
    expect(sql).toHaveBeenCalledTimes(6)
  })

  it('routes full-contract skill through dispatchRun', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)

    const fullConfig = {
      metric: 'failures_per_day',
      prompt: 'run the skill',
      epochs: 3,
      worktree: true,
      git: true,
      pr: false,
    }
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const cronRow = {
      id: 'cron-1',
      name: 'test-cron',
      config: { schedule: '* * * * *', enabled: true, prompt: 'do stuff' },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'test-skill',
      skill_config: fullConfig,
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [cronRow],              // main query
      [],                     // gate 1: no metric
      [],                     // gate 2: no active process
      [{ count: 0 }],        // gate 3: 0 failures today
      [{ id: 'proc-uuid' }], // atomic INSERT
      [],                     // UPDATE status = 'completed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    expect(dispatchRunMock).toHaveBeenCalledWith({
      skill_id: 'skill-1',
      skill_config: fullConfig,
    })
    // reap + main + gate1 + gate2 + gate3 + atomic insert + UPDATE = 7
    expect(sql).toHaveBeenCalledTimes(7)
  })

  it('bypass cron fires with capped INSERT (daily limit, no active-process guard)', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const bypassCronRow = {
      id: 'cron-bypass',
      name: 'bypass-cron',
      config: { schedule: '* * * * *', enabled: true, prompt: 'bypass stuff', bypass_idempotency: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'bypass-skill',
      skill_config: { content: 'bypass content' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [bypassCronRow],        // main query
      // shouldDispatch NOT called (bypass skips gates)
      [{ id: 'proc-uuid' }], // capped INSERT (SELECT ... WHERE count < 50) returns new process
      [],                     // UPDATE status = 'completed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // reap + main query + capped INSERT + UPDATE = 4 (no active-process gate queries!)
    expect(sql).toHaveBeenCalledTimes(4)
    expect(dispatchRunMock).toHaveBeenCalled()
  })

  describe('Gate 0: dependency check', () => {
    it('skips cron when depends_on metric is not in 24h window', async () => {
      const collectModule = await import('@duoidal/utils/dispatch')
      const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
      dispatchRunMock.mockClear()

      const mockCron = {
        id: 'cron-1',
        name: 'developer-leverage-cron',
        config: { schedule: '* * * * *', enabled: true, depends_on: ['human_equivalent_hours_per_day'] },
        created_at: new Date(),
        skill_id: 'skill-dl',
        skill_name: 'developer-leverage',
        skill_config: { metric: 'developer_leverage', content: 'test' },
        skill_type: 'skill',
        type_prompt_prefix: null,
        type_prompt_segments: null,
      }

      // responses: [0] reap (no stale), [1] cron rows, [2] Gate 0 dep check returns empty (missing), no further calls
      const sql = createMockSql([[], [mockCron], []])
      await poll(sql)
      expect(dispatchRunMock).not.toHaveBeenCalled()
    })

    it('proceeds when depends_on metric exists in 24h window', async () => {
      const collectModule = await import('@duoidal/utils/dispatch')
      const validateMock = vi.mocked(collectModule.validateSkillConfig)
      validateMock.mockReturnValue(true)
      vi.mocked(collectModule.dispatchRun).mockResolvedValue('completed')

      const mockCron = {
        id: 'cron-1',
        name: 'developer-leverage-cron',
        config: { schedule: '* * * * *', enabled: true, depends_on: ['human_equivalent_hours_per_day'] },
        created_at: new Date(),
        skill_id: 'skill-dl',
        skill_name: 'developer-leverage',
        skill_config: { content: 'test prompt' },
        skill_type: 'skill',
        type_prompt_prefix: null,
        type_prompt_segments: null,
      }

      // responses: [0] reap (no stale), [1] cron rows, [2] Gate 0 dep found, [3] Gate 1 metric check (skip → exists)
      const sql = createMockSql([[], [mockCron], [{ '1': 1 }], [{ '1': 1 }]])
      await poll(sql)
      // Should skip at gate 1 (metric exists), not at gate 0
      expect(vi.mocked(collectModule.dispatchRun)).not.toHaveBeenCalled()
    })
  })

  it('evaluates formula resource and writes result to metric_snapshots', async () => {
    const formulaCronRow = {
      id: 'cron-formula',
      name: 'formula-test-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-formula',
      skill_name: 'formula-test',
      skill_config: { formula: 'a + b', content: 'formula test' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [formulaCronRow],       // main query
      [],                     // shouldDispatch Gate 1 formula: no metric snapshot today → proceed
      [],                     // shouldDispatch Gate 2: no active process
      [{ count: 0 }],         // shouldDispatch Gate 3: 0 failures
      [{ id: 'proc-uuid' }], // atomic INSERT returns new process id
      [{ value: '5' }],       // ingredient fetch for 'a'
      [{ value: '2' }],       // ingredient fetch for 'b'
      [],                     // INSERT metric_snapshots
      [],                     // UPDATE processes
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // reap + main + gate1 + gate2 + gate3 + atomic insert + fetch a + fetch b + INSERT snapshots + UPDATE = 10
    expect(sql).toHaveBeenCalledTimes(10)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('formula-test: formula_test_per_day = 7')
    )
  })

  it('marks process failed when formula contains disallowed characters', async () => {
    const badFormulaCronRow = {
      id: 'cron-bad',
      name: 'bad-formula-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-bad',
      skill_name: 'bad-formula',
      skill_config: { formula: 'a; process.exit(1)', content: 'malicious formula' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    const responses: unknown[][] = [
      [],                    // reapStalePending UPDATE
      [badFormulaCronRow],   // main query
      [],                    // Gate 1 formula: no metric snapshot today → proceed
      [],                    // Gate 2: no active process
      [{ count: 0 }],        // Gate 3: 0 failures
      [{ id: 'proc-uuid' }], // atomic INSERT returns new process id
      [],                    // UPDATE processes (failed)
    ]

    const sql = createMockSql(responses)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await poll(sql)

    expect(sql).toHaveBeenCalledTimes(7)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('bad-formula'),
      expect.stringContaining('disallowed character'),
    )
  })

  it('skips formula resource cron when formula metric already recorded today', async () => {
    const formulaCronRow = {
      id: 'cron-dl',
      name: 'developer-leverage-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-dl',
      skill_name: 'developer-leverage',
      skill_config: { formula: 'agent_hours_per_day**2 / (human_equivalent_hours_per_day * 12)', content: 'audit deps' },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                // reapStalePending UPDATE (no stale rows)
      [formulaCronRow],  // main query
      [{ '1': 1 }],     // Gate 1 formula: formula metric snapshot found today → skip
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    expect(sql).toHaveBeenCalledTimes(3)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('developer_leverage_per_day already recorded today')
    )
  })

  it('failures-in-prod skill dispatches via dispatchRun', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)

    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const failuresInProdSkillConfig = {
      metric: 'failures_per_day',
      content: 'Check for production failures',
    }

    const cronRow = {
      id: 'cron-failures',
      name: 'failures-in-prod',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-failures',
      skill_name: 'failures-in-prod',
      skill_config: failuresInProdSkillConfig,
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [cronRow],              // main query
      [],                     // gate 1: no metric
      [],                     // gate 2: no active process
      [{ count: 0 }],        // gate 3: 0 failures today
      [{ id: 'proc-uuid' }], // atomic INSERT
      [],                     // UPDATE status = 'completed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    expect(dispatchRunMock).toHaveBeenCalledWith({
      skill_id: 'skill-failures',
      skill_config: failuresInProdSkillConfig,
    })
  })

  // ── Agent-type dispatch tests ───────────────────────────────────────────────

  it('max_dispatches_per_day: skips agent when daily cap reached', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    dispatchRunMock.mockClear()

    const agentCronRow = {
      id: 'cron-agent',
      name: 'agent-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-agent',
      skill_name: 'my-agent',
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'fix things',
        max_dispatches_per_day: 3,
      },
      skill_type: 'agent',
      type_prompt_prefix: '[prefix]',
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                         // reapStalePending UPDATE (no stale rows)
      [agentCronRow],             // main query
      [{ count: '3' }],           // max_dispatches COUNT (3 >= 3, cap reached)
      // no further calls — skipped
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    expect(dispatchRunMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('[poller] skip: daily cap reached for my-agent')
  })

  it('agent-type uses goal_metric as idempotency key', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const agentCronRow = {
      id: 'cron-agent',
      name: 'agent-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-agent',
      skill_name: 'my-agent',
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'fix things',
      },
      skill_type: 'agent',
      type_prompt_prefix: '[prefix]',
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                     // reapStalePending UPDATE (no stale rows)
      [agentCronRow],         // main query
      [{ '1': 1 }],           // shouldDispatch gate 1: metric 'failures_per_day' exists → skip
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // Should have called shouldDispatch with failures_per_day (goal_metric) — gate 1 fires and skips
    expect(dispatchRunMock).not.toHaveBeenCalled()
    // The gate 1 SQL call (index 2) uses 'failures_per_day' as metric key
    const gate1Call = vi.mocked(sql).mock.calls[2]
    expect(gate1Call[2]).toBe('failures_per_day')
  })

  it('agent-type dispatches via dispatchRun with assembled content', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const agentCronRow = {
      id: 'cron-agent',
      name: 'agent-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-agent',
      skill_name: 'my-agent',
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'fix things',
      },
      skill_type: 'agent',
      type_prompt_prefix: '[agent prefix]',
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                         // reapStalePending UPDATE (no stale rows)
      [agentCronRow],             // main query
      [],                         // gate 1: no metric snapshot (shouldDispatch passes)
      [],                         // gate 2: no active process
      [{ id: 'proc-uuid' }],     // atomic INSERT
      [{ value: 5 }],             // getMetricValue for goal_metric
      [],                         // UPDATE status = 'completed'
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    expect(dispatchRunMock).toHaveBeenCalledOnce()
    const callArgs = dispatchRunMock.mock.calls[0][0]
    expect(callArgs.skill_id).toBe('skill-agent')
    // assembled content should include the prefix and goal block
    const content = callArgs.skill_config?.content as string
    expect(content).toContain('[agent prefix]')
    expect(content).toContain('failures_per_day')
    expect(content).toContain('fix things')
  })

  it('skill-type uses config.metric not goal_metric', async () => {
    const collectModule = await import('@duoidal/utils/dispatch')
    const validateMock = vi.mocked(collectModule.validateSkillConfig)
    const dispatchRunMock = vi.mocked(collectModule.dispatchRun)
    validateMock.mockReturnValue(true)
    dispatchRunMock.mockResolvedValue('completed')

    const skillCronRow = {
      id: 'cron-skill',
      name: 'skill-cron',
      config: { schedule: '* * * * *', enabled: true },
      created_at: new Date('2020-01-01'),
      skill_id: 'skill-1',
      skill_name: 'my-skill',
      skill_config: {
        metric: 'some_key',
        content: 'do the skill',
      },
      skill_type: 'skill',
      type_prompt_prefix: null,
      type_prompt_segments: null,
    }

    let callIndex = 0
    const responses: unknown[][] = [
      [],                         // reapStalePending UPDATE (no stale rows)
      [skillCronRow],             // main query
      [{ '1': 1 }],               // gate 1: metric 'some_key' exists → skip
    ]

    const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = responses[callIndex] ?? []
      callIndex++
      return Promise.resolve(result)
    }) as unknown as ReturnType<typeof import('postgres')>

    vi.spyOn(console, 'log').mockImplementation(() => {})

    await poll(sql)

    // Skipped at gate 1 due to 'some_key' metric existing
    expect(dispatchRunMock).not.toHaveBeenCalled()
    // Verify gate 1 used 'some_key' as metric key (3rd SQL arg, index 2 after reap shift)
    const gate1Call = vi.mocked(sql).mock.calls[2]
    expect(gate1Call[2]).toBe('some_key')
  })
})

describe('reapStalePending', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks stale pending processes (>10 min) as failed', async () => {
    // Simulate a stale row being updated → returned
    const staleProcId = 'stale-proc-uuid'
    const sql = createMockSql([[{ id: staleProcId }]])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await reapStalePending(sql)

    expect(sql).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(`[poller] reaped stale pending process: ${staleProcId}`)
  })

  it('does nothing when no stale pending processes exist', async () => {
    const sql = createMockSql([[]])

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await reapStalePending(sql)

    expect(sql).toHaveBeenCalledTimes(1)
    expect(logSpy).not.toHaveBeenCalled()
  })
})
