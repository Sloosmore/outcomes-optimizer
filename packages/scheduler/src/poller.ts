import { CronExpressionParser } from 'cron-parser'
import {
  type CronRow,
  type CronStore,
  createPostgresCronStore,
  buildAgentPrompt,
} from './poller-service.js'
import { getSqlClient, type Sql } from '@skill-networks/database/client'
import { validateSkillConfig, dispatchRun } from '@duoidal/utils/dispatch'

// Must be >= the daemon's POLL_INTERVAL_MS so no cron fire falls outside the window
const POLL_WINDOW_MS = 5 * 60 * 1000
const STALE_PENDING_THRESHOLD_MS = 10 * 60 * 1000

export async function reapStalePending(sql: Sql): Promise<void> {
  const reaped = await sql<{ id: string }[]>`
    UPDATE processes
    SET status = 'failed', updated_at = NOW()
    WHERE status = 'pending'
      AND created_at < NOW() - (${STALE_PENDING_THRESHOLD_MS} * interval '1 millisecond')
    RETURNING id
  `
  for (const row of reaped) {
    console.log(`[poller] reaped stale pending process: ${row.id}`)
  }
}

// ── Safe arithmetic evaluator ─────────────────────────────────────────────────
// Replaces new Function() / eval for formula resources. The tokenizer rejects
// any character that isn't part of arithmetic syntax before parsing begins, so
// prototype-chain attacks (e.g. (1).constructor.constructor(...)) are blocked at
// the tokenizer level — a '.' never becomes a valid token.

/**
 * Tokenizes a formula string into arithmetic tokens.
 * Allowed: whitespace (skipped), operators (+, -, *, /, **, (, )),
 * numeric literals (integer or decimal), and identifiers ([a-zA-Z_]\w*).
 * Any other character throws immediately.
 */
function tokenizeFormula(formula: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '*' && formula[i + 1] === '*') { tokens.push('**'); i += 2; continue }
    if ('+-*/()'.includes(ch)) { tokens.push(ch); i++; continue }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(formula[i + 1] ?? ''))) {
      let num = ''
      while (i < formula.length && /[\d.]/.test(formula[i])) num += formula[i++]
      tokens.push(num)
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let id = ''
      while (i < formula.length && /\w/.test(formula[i])) id += formula[i++]
      tokens.push(id)
      continue
    }
    throw new Error(`formula contains disallowed character: ${JSON.stringify(ch)}`)
  }
  return tokens
}

/**
 * Evaluates a pre-tokenized arithmetic expression with named variable substitution.
 * Grammar (lowest → highest precedence):
 *   expr  → term (('+' | '-') term)*
 *   term  → power (('*' | '/') power)*
 *   power → unary ('**' power)*         ← right-associative
 *   unary → ('-' | '+') unary | atom
 *   atom  → '(' expr ')' | NUMBER | IDENT
 * Throws on unknown identifiers, division by zero, or malformed input.
 * Never touches global scope — all variable lookup goes through `vars`.
 */
function evalArithmeticTokens(tokens: string[], vars: Record<string, number>): number {
  let pos = 0
  const peek = (): string | undefined => tokens[pos]
  const consume = (): string => tokens[pos++]

  function parseExpr(): number {
    let val = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = consume()
      const right = parseTerm()
      val = op === '+' ? val + right : val - right
    }
    return val
  }

  function parseTerm(): number {
    let val = parsePower()
    while (peek() === '*' || peek() === '/') {
      const op = consume()
      const right = parsePower()
      if (op === '/' && right === 0) throw new Error('division by zero')
      val = op === '*' ? val * right : val / right
    }
    return val
  }

  function parsePower(): number {
    const base = parseUnary()
    if (peek() === '**') {
      consume()
      return Math.pow(base, parsePower())  // right-associative
    }
    return base
  }

  function parseUnary(): number {
    if (peek() === '-') { consume(); return -parseUnary() }
    if (peek() === '+') { consume(); return parseUnary() }
    return parseAtom()
  }

  function parseAtom(): number {
    const tok = peek()
    if (tok === '(') {
      consume()
      const val = parseExpr()
      if (peek() !== ')') throw new Error('missing closing parenthesis')
      consume()
      return val
    }
    if (tok !== undefined && /^\d/.test(tok)) {
      consume()
      return parseFloat(tok)
    }
    if (tok !== undefined && /^[a-zA-Z_]/.test(tok)) {
      consume()
      if (!(tok in vars)) throw new Error(`formula references unknown identifier: ${tok}`)
      return vars[tok]
    }
    throw new Error(`unexpected token: ${JSON.stringify(tok ?? 'end of formula')}`)
  }

  const result = parseExpr()
  if (pos !== tokens.length) throw new Error(`unexpected token: ${JSON.stringify(tokens[pos])}`)
  return result
}

// ── poll() ───────────────────────────────────────────────────────────────────

export async function poll(sql: Sql): Promise<void> {
  await reapStalePending(sql)
  const store: CronStore = createPostgresCronStore(sql)
  const rows = await store.getCronsDue()

  const now = new Date()

  for (const cron of rows) {
    // Compute the most recent past fire time. If it falls within the poll
    // interval window, the cron is due. Using prev() avoids the off-by-one
    // that occurs with next() when anchor = now (next() is always in the future).
    let prevFire: Date
    try {
      prevFire = CronExpressionParser.parse(cron.config.schedule, {
        currentDate: now,
        tz: 'UTC',
      }).prev().toDate()
    } catch (err) {
      console.error(`[poller] Bad cron expression for ${cron.name}:`, (err as Error).message)
      continue
    }

    if (now.getTime() - prevFire.getTime() > POLL_WINDOW_MS) continue

    // Gate 0: dependency check — skip if required upstream metrics aren't recorded today
    const dependsOn = cron.config.depends_on
    if (Array.isArray(dependsOn) && dependsOn.length > 0) {
      let depMissing = false
      for (const dep of dependsOn) {
        const depRows = await sql`
          SELECT 1 FROM metric_snapshots
          WHERE metric_key = ${dep}
            AND measured_at >= date_trunc('day', NOW())
        `
        if (depRows.length === 0) {
          console.log(`[poller] Skipping ${cron.skill_name}: dependency ${dep} not yet recorded`)
          depMissing = true
          break
        }
      }
      if (depMissing) continue
    }

    // max_dispatches_per_day pre-flight: agent-type only
    if (cron.skill_type === 'agent' && typeof cron.skill_config?.max_dispatches_per_day === 'number') {
      const maxPerDay = cron.skill_config.max_dispatches_per_day as number
      const countRows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM processes
        WHERE skill_resource_id = ${cron.skill_id}
          AND created_at >= date_trunc('day', NOW())
      `
      const todayCount = parseInt(countRows[0]?.count ?? '0', 10)
      if (todayCount >= maxPerDay) {
        console.log(`[poller] skip: daily cap reached for ${cron.skill_name}`)
        continue
      }
    }

    // Two-gate idempotency check
    // For agent-type: use goal_metric as the metricKey (goal_metric wins over metric)
    let metricKey: string | undefined
    if (cron.skill_type === 'agent') {
      metricKey = typeof cron.skill_config?.goal_metric === 'string'
        ? cron.skill_config.goal_metric
        : typeof cron.skill_config?.metric === 'string'
          ? cron.skill_config.metric
          : undefined
    } else {
      metricKey = typeof cron.skill_config?.metric === 'string'
        ? cron.skill_config.metric
        : undefined
    }
    const formulaResource = typeof cron.skill_config?.formula === 'string'
    const maxFailuresPerDay = typeof cron.skill_config?.max_failures_per_day === 'number'
      ? cron.skill_config.max_failures_per_day
      : undefined
    // For formula resources: derive the target metric key for idempotency checking via metric_snapshots
    const formulaMetricKey = formulaResource
      ? typeof cron.skill_config?.formula_metric === 'string'
        ? cron.skill_config.formula_metric
        : cron.skill_name.replace(/-/g, '_') + '_per_day'
      : undefined
    const result = await store.shouldDispatch(cron.skill_id, metricKey, cron.config.bypass_idempotency, formulaResource, maxFailuresPerDay, formulaMetricKey)
    if (result.skip) {
      console.log(`[poller] Skipping ${cron.skill_name}: ${result.reason}`)
      continue
    }

    // Resolve prompt for non-agent: prefer skill's config.content, fall back to cron's config.prompt
    if (cron.skill_type !== 'agent') {
      const rawSkillContent = cron.skill_config?.content
      const skillContent = typeof rawSkillContent === 'string' ? rawSkillContent : undefined
      const resolvedPrompt = skillContent ?? cron.config.prompt
      if (!resolvedPrompt) {
        console.warn(`[poller] Skipping cron ${cron.name}: no content/prompt found on linked skill ${cron.skill_name} or cron config`)
        continue
      }
    }

    // Claim dispatch slot atomically: insert only if no active/pending process exists today.
    // This collapses gate 2 and the insert into a single statement, preventing races
    // between concurrent poll instances.
    const timestamp = Date.now()
    const processName = `cron-${cron.name}-${timestamp}`
    let processId: string
    try {
      if (cron.config.bypass_idempotency === true) {
        // Bypass mode: INSERT unconditionally but cap at 50 processes per skill per day
        const insertResult = await sql<{ id: string }[]>`
          INSERT INTO processes (name, skill_resource_id, status, started_at)
          SELECT ${processName}, ${cron.skill_id}, 'active', NOW()
          WHERE (
            SELECT count(*) FROM processes
            WHERE skill_resource_id = ${cron.skill_id}
              AND created_at >= date_trunc('day', NOW())
          ) < 50
          RETURNING id
        `
        if (!insertResult[0]) {
          console.log(`[poller] Skipping ${cron.skill_name}: daily bypass cap reached`)
          continue
        }
        processId = insertResult[0].id
      } else {
        // Normal mode: atomic INSERT with WHERE NOT EXISTS guard prevents double-firing
        const insertResult = await sql<{ id: string }[]>`
          INSERT INTO processes (name, skill_resource_id, status, started_at)
          SELECT ${processName}, ${cron.skill_id}, 'active', NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM processes
            WHERE skill_resource_id = ${cron.skill_id}
              AND status IN ('active', 'pending')
              AND created_at >= date_trunc('day', NOW())
          )
          RETURNING id
        `
        if (!insertResult[0]) {
          // Another instance claimed this slot concurrently
          console.log(`[poller] Skipping ${cron.skill_name}: claimed by concurrent instance`)
          continue
        }
        processId = insertResult[0].id
      }
    } catch (err) {
      console.error(`[poller] Error creating process for ${cron.name}:`, (err as Error).message)
      continue
    }

    console.log(`[poller] Dispatching ${cron.skill_name} (process: ${processId})`)

    let dispatchStatus: 'completed' | 'failed'
    try {
      if (formulaResource) {
        // Formula resource: evaluate the formula using ingredient metric values and record to metric_snapshots.
        // Does not dispatch an agent — the formula is computed directly in the poller.
        const formula = cron.skill_config!.formula as string
        // formulaMetricKey was already derived above for the idempotency check
        // Extract ingredient variable names (identifier tokens) from the formula.
        // tokenizeFormula() rejects any character outside arithmetic syntax (including '.'
        // which blocks prototype-chain attacks), so the Set() here is safe to use.
        let formulaTokens: string[]
        try {
          formulaTokens = tokenizeFormula(formula)
        } catch (tokenErr) {
          console.error(`[poller] Formula eval failed for ${cron.skill_name}:`, (tokenErr as Error).message)
          dispatchStatus = 'failed'
          await sql`UPDATE processes SET status = ${dispatchStatus}, completed_at = NOW() WHERE id = ${processId}`
          continue
        }
        const ingredientNames = [...new Set(
          formulaTokens.filter(tok => /^[a-zA-Z_]/.test(tok))
        )]
        // Fetch today's value of each ingredient from metric_snapshots
        const ingredientValues: Record<string, number> = {}
        for (const name of ingredientNames) {
          const rows = await sql<{ value: string }[]>`
            SELECT value FROM metric_snapshots
            WHERE metric_key = ${name}
              AND measured_at >= date_trunc('day', NOW())
            ORDER BY measured_at DESC LIMIT 1
          `
          if (rows.length > 0) {
            const parsed = parseFloat(rows[0].value)
            if (!Number.isFinite(parsed)) {
              throw new Error(`ingredient ${name} has non-numeric value: ${rows[0].value}`)
            }
            ingredientValues[name] = parsed
          }
        }
        // Evaluate the formula using a safe recursive-descent parser.
        // evalArithmeticTokens() only resolves identifiers via the vars map —
        // it never touches the global scope or prototype chain.
        let formulaValue: number
        try {
          const missing = ingredientNames.filter(n => !(n in ingredientValues))
          if (missing.length > 0) {
            throw new Error(`missing ingredient metrics: ${missing.join(', ')}`)
          }
          formulaValue = evalArithmeticTokens(formulaTokens, ingredientValues)
          if (!Number.isFinite(formulaValue)) {
            throw new Error(`formula evaluated to non-finite value: ${formulaValue}`)
          }
        } catch (evalErr) {
          console.error(`[poller] Formula eval failed for ${cron.skill_name}:`, (evalErr as Error).message)
          dispatchStatus = 'failed'
          await sql`UPDATE processes SET status = ${dispatchStatus}, completed_at = NOW() WHERE id = ${processId}`
          continue
        }
        // Write result to metric_snapshots (formulaMetricKey is always defined when formulaResource=true)
        const targetMetricKey = formulaMetricKey!
        await sql`
          INSERT INTO metric_snapshots (skill_id, metric_key, value, measured_at, metadata)
          VALUES (
            ${cron.skill_id},
            ${targetMetricKey},
            ${formulaValue},
            NOW(),
            ${JSON.stringify({ formula, ingredients: ingredientValues })}::jsonb
          )
        `
        console.log(`[poller] Formula ${cron.skill_name}: ${targetMetricKey} = ${formulaValue} (ingredients: ${JSON.stringify(ingredientValues)})`)
        dispatchStatus = 'completed'
      } else if (cron.skill_type === 'agent') {
        // Agent-type: assemble prompt with goal-metric block, then dispatch
        const metricValue = cron.skill_config?.goal_metric
          ? await store.getMetricValue(cron.skill_id, cron.skill_config.goal_metric as string)
          : null
        const assembledPrompt = buildAgentPrompt(cron, metricValue)
        const assembledConfig = { ...cron.skill_config, content: assembledPrompt }
        if (!validateSkillConfig(assembledConfig)) {
          console.warn(`[poller] Skipping ${cron.skill_name}: assembled agent config failed validation`)
          dispatchStatus = 'failed'
        } else {
          dispatchStatus = await dispatchRun({ skill_id: cron.skill_id, skill_config: assembledConfig })
        }
      } else {
        // Skill-type: validate raw config and dispatch
        if (!validateSkillConfig(cron.skill_config)) {
          console.warn(`[poller] Skipping ${cron.skill_name}: skill config failed validation`)
          dispatchStatus = 'failed'
        } else {
          dispatchStatus = await dispatchRun({ skill_id: cron.skill_id, skill_config: cron.skill_config })
        }
      }
    } catch (err) {
      console.error(`[poller] Error dispatching ${cron.skill_name}:`, (err as Error).message)
      dispatchStatus = 'failed'
    }
    try {
      await sql`UPDATE processes SET status = ${dispatchStatus}, completed_at = NOW() WHERE id = ${processId}`
    } catch (updateErr) {
      console.error(`[poller] Failed to update process ${processId} to ${dispatchStatus}:`, (updateErr as Error).message)
    }
  }
}

// ── Daemon mode ──────────────────────────────────────────────────────────────

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/poller.ts') || process.argv[1].endsWith('/poller'))

const STARTUP_DELAY_MS = 60_000 // let gateway start before first poll

if (isMain) {
  const sql = getSqlClient()

  console.log('[poller] Started (interval: 5m)')

  // Sequential loop: wait for poll() to finish before scheduling the next one,
  // preventing overlapping poll cycles when a dispatch takes longer than the interval.
  async function loop(): Promise<void> {
    await poll(sql).catch(e => console.error('[poller] Poll error:', e.message))
    setTimeout(loop, POLL_WINDOW_MS)
  }

  setTimeout(loop, STARTUP_DELAY_MS)
}
