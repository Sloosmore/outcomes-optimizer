import { buildRalphPrompt } from '../index.js'

describe('buildRalphPrompt', () => {
  it('builds prompt with epoch variables replaced', () => {
    const prompt = buildRalphPrompt({
      goal: 'Build a test system',
      epoch: 3,
      maxEpochs: 10,
    })

    // Should contain epoch info
    expect(prompt).toContain('3 of 10')
    expect(prompt).not.toContain('$EPOCH')
    expect(prompt).not.toContain('$MAX_EPOCHS')
  })

  it('includes the goal', () => {
    const goal = 'Create an amazing feature'
    const prompt = buildRalphPrompt({
      goal,
      epoch: 1,
      maxEpochs: 5,
    })

    expect(prompt).toContain(goal)
  })

  it('includes test set path when provided', () => {
    const prompt = buildRalphPrompt({
      goal: 'Test goal',
      epoch: 1,
      maxEpochs: 5,
      testSetPath: './workspace/training_data/',
    })

    expect(prompt).toContain('./workspace/training_data/')
    expect(prompt).toContain('Use this test set for validation')
  })

  it('includes generate-your-own message when no test set', () => {
    const prompt = buildRalphPrompt({
      goal: 'Test goal',
      epoch: 1,
      maxEpochs: 5,
    })

    expect(prompt).toContain('No test set provided')
    expect(prompt).toContain('You MUST generate your own test set')
  })

  it('includes optimization framework content', () => {
    const prompt = buildRalphPrompt({
      goal: 'Optimize something',
      epoch: 1,
      maxEpochs: 10,
    })

    // From optimization framework
    expect(prompt).toContain('Measure (if applicable) → Hypothesize → Change → Verify measurability → Repeat')
    expect(prompt).toContain('Optimization Framework')
  })

  it('includes leader instructions', () => {
    const prompt = buildRalphPrompt({
      goal: 'Lead a team',
      epoch: 1,
      maxEpochs: 10,
    })

    // From SYSTEM.md (unified prompt)
    expect(prompt).toContain('Optimization Cycle — System Prompt')
    expect(prompt).toContain('workspace/prd-{id}.json')
    expect(prompt).toContain('workspace/progress.md')
  })

  it('replaces epoch variables', () => {
    const prompt = buildRalphPrompt({
      goal: 'Test',
      epoch: 2,
      maxEpochs: 5,
    })

    expect(prompt).not.toContain('$EPOCH')
    expect(prompt).not.toContain('$MAX_EPOCHS')
    expect(prompt).toContain('2 of 5')
  })

  it('replaces $WORKING_DIR with provided workingDir', () => {
    const prompt = buildRalphPrompt({
      goal: 'Test',
      epoch: 1,
      maxEpochs: 5,
      workingDir: '/custom/work/dir',
    })

    expect(prompt).not.toContain('$WORKING_DIR')
    expect(prompt).toContain('/custom/work/dir/workspace/state.json')
    expect(prompt).toContain('/custom/work/dir/workspace/progress.md')
    expect(prompt).toContain('/custom/work/dir/workspace/prd-{id}.json')
  })

  it('replaces $WORKING_DIR with process.cwd() when workingDir omitted and WORKTREE_PATH unset', () => {
    const saved = process.env.WORKTREE_PATH
    try {
      delete process.env.WORKTREE_PATH

      const prompt = buildRalphPrompt({
        goal: 'Test',
        epoch: 1,
        maxEpochs: 5,
      })

      expect(prompt).not.toContain('$WORKING_DIR')
      expect(prompt).toContain(process.cwd())
    } finally {
      if (saved !== undefined) process.env.WORKTREE_PATH = saved
      else delete process.env.WORKTREE_PATH
    }
  })
})
