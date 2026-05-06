import { describe, it, expect } from 'vitest'
import { buildAgentPrompt, type CronRow } from './poller-service.js'

function makeRow(overrides: Partial<CronRow>): CronRow {
  return {
    id: 'cron-1',
    name: 'test-cron',
    config: { schedule: '* * * * *', enabled: true },
    created_at: new Date('2020-01-01'),
    skill_id: 'skill-1',
    skill_name: 'test-skill',
    skill_config: null,
    skill_type: 'skill',
    type_prompt_prefix: null,
    type_prompt_segments: null,
    ...overrides,
  }
}

describe('buildAgentPrompt', () => {
  it('assembles prefix + goal block + content when skill_type=agent and goal_metric set', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[general agent framing]',
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do the thing',
      },
    })
    const result = buildAgentPrompt(row, 5)
    expect(result).toBe(
      '[general agent framing]\n\nGoal metric: failures_per_day\nCurrent value: 5\nTarget: ≤ 2 (minimize)\n\ndo the thing'
    )
  })

  it('appends autonomous segment when config.autonomous="true"', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[general agent framing]',
      type_prompt_segments: { autonomous: '[autonomous instructions]' },
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do the thing',
        autonomous: 'true',
      },
    })
    const result = buildAgentPrompt(row, 5)
    expect(result).toBe(
      '[general agent framing]\n\nGoal metric: failures_per_day\nCurrent value: 5\nTarget: ≤ 2 (minimize)\n\ndo the thing\n\n[autonomous instructions]'
    )
  })

  it('appends goal segment when config.goal=true and substitutes {{goal_metric}}', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[general agent framing]',
      type_prompt_segments: { goal: 'commit docs/goals/{{goal_metric}}.md' },
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do the thing',
        goal: true,
      },
    })
    const result = buildAgentPrompt(row, 5)
    expect(result).toContain('commit docs/goals/failures_per_day.md')
  })

  it('does not append segment when flag is not set on skill config', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[general agent framing]',
      type_prompt_segments: { goal: 'commit docs/goals/{{goal_metric}}.md' },
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do the thing',
        // goal not set
      },
    })
    const result = buildAgentPrompt(row, 5)
    expect(result).not.toContain('commit docs/goals')
  })

  it('appends both segments when multiple flags are enabled', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[general agent framing]',
      type_prompt_segments: {
        autonomous: '[autonomous instructions]',
        goal: 'commit docs/goals/{{goal_metric}}.md',
      },
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do the thing',
        autonomous: 'true',
        goal: true,
      },
    })
    const result = buildAgentPrompt(row, 5)
    expect(result).toContain('[autonomous instructions]')
    expect(result).toContain('commit docs/goals/failures_per_day.md')
  })

  it('returns only content when skill_type=agent but no goal_metric', () => {
    const row = makeRow({
      skill_type: 'agent',
      skill_config: { content: 'bare content' },
    })
    const result = buildAgentPrompt(row, null)
    expect(result).toBe('bare content')
  })

  it('returns only content for skill-type resources (no prefix)', () => {
    const row = makeRow({
      skill_type: 'skill',
      skill_config: { content: 'skill content', metric: 'some_key' },
    })
    const result = buildAgentPrompt(row, null)
    expect(result).toBe('skill content')
  })

  it('does not crash with null metricValue for agent type with goal_metric', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[prefix]',
      skill_config: {
        goal_metric: 'failures_per_day',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do it',
      },
    })
    const result = buildAgentPrompt(row, null)
    expect(result).toContain('Current value: N/A')
    expect(result).toContain('failures_per_day')
  })

  it('goal_metric wins over metric when both present', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[prefix]',
      skill_config: {
        goal_metric: 'failures_per_day',
        metric: 'some_key',
        target_value: '2',
        target_direction: 'minimize',
        content: 'do it',
      },
    })
    const result = buildAgentPrompt(row, 3)
    expect(result).toContain('failures_per_day')
    // goal block should NOT mention 'some_key'
    const goalBlock = result.split('\n\ndo it')[0]
    expect(goalBlock).not.toContain('some_key')
  })

  it('uses maximize symbol when target_direction=maximize', () => {
    const row = makeRow({
      skill_type: 'agent',
      type_prompt_prefix: '[prefix]',
      skill_config: {
        goal_metric: 'throughput',
        target_value: '100',
        target_direction: 'maximize',
        content: 'do it',
      },
    })
    const result = buildAgentPrompt(row, 80)
    expect(result).toContain('Target: ≥ 100 (maximize)')
  })
})
