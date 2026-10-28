import { createHash } from 'node:crypto'
import { makePlan, completePlan } from '../tools/lib/night-plan.mjs'

export function stableRunId(plan) {
  const identity = [plan?.windowKey ?? '', plan?.atMs ?? '', plan?.action ?? ''].join('|')
  return 'wake-' + createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function createAutonomousScheduler({
  readConfig,
  readState,
  writeState,
  runOnce,
  now = Date.now,
  log = () => {},
  makePlanFn = makePlan,
  completePlanFn = completePlan,
} = {}) {
  for (const [name, fn] of Object.entries({ readConfig, readState, writeState, runOnce })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function')
  }
  let active = null

  async function tick({ signal } = {}) {
    if (active) return { status: 'busy' }
    active = runTick(signal)
    try { return await active } finally { active = null }
  }

  async function runTick(signal) {
    let plan
    try {
      if (signal?.aborted) throw new Error('Autonomous scheduler cancelled')
      const currentTime = now()
      plan = makePlanFn(readConfig(), readState() ?? {}, currentTime)
      writeState(plan)
      if (plan.action === 'done' || !Number.isFinite(plan.atMs) || currentTime < plan.atMs) {
        return { status: 'waiting', plan }
      }
      const runId = stableRunId(plan)
      const result = await runOnce({ action: plan.action, plan, runId, signal })
      if (!result?.diaryRecorded) throw new Error('Autonomous run did not confirm a diary entry')
      const completed = completePlanFn(plan, now())
      writeState(completed)
      log('[whale-agent] completed ' + plan.action + ' ' + runId)
      return { status: 'completed', plan: completed, result }
    } catch (error) {
      // The pending plan was persisted before model execution. Keep it intact so a restart
      // retries the same runId; the memory journal makes diary recording idempotent.
      log('[whale-agent] run failed; pending plan retained: ' + String(error?.message ?? error).slice(0, 500))
      return { status: 'failed', plan, error: String(error?.message ?? error) }
    }
  }

  return {
    tick,
    get busy() { return Boolean(active) },
  }
}
