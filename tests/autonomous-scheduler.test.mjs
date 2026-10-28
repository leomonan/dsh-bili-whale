import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutonomousScheduler, stableRunId } from '../lib/autonomous-scheduler.js'

function fixture(options = {}) {
  let state = options.state ?? null
  let currentTime = options.now ?? 200
  const writes = []
  const runs = []
  const logs = []
  const plan = options.plan ?? { action: 'wake', atMs: 100, windowKey: '2026-10-29|20:00–24:00', atText: '2026-10-29 20:10' }
  const scheduler = createAutonomousScheduler({
    readConfig: () => ({ windows: [] }),
    readState: () => state,
    writeState: value => { state = structuredClone(value); writes.push(structuredClone(value)) },
    now: () => currentTime,
    shouldDefer: options.shouldDefer ?? (() => false),
    makePlanFn: (_config, previous) => previous?.action && previous.action !== 'done' && !previous.fired ? previous : plan,
    completePlanFn: value => ({ ...value, fired: true, woke: value.action === 'wake' }),
    runOnce: async args => {
      runs.push(args)
      if (options.runOnce) return options.runOnce(args)
      return { diaryRecorded: true }
    },
    log: message => logs.push(message),
  })
  return { scheduler, writes, runs, logs, get state() { return state }, setNow(value) { currentTime = value } }
}

test('due plan runs once and is marked complete only after diary confirmation', async () => {
  const f = fixture()
  const result = await f.scheduler.tick()
  assert.equal(result.status, 'completed')
  assert.equal(f.runs.length, 1)
  assert.equal(result.plan.fired, true)
  assert.equal(f.state.fired, true)
  assert.equal(f.writes.length, 2, 'pending plan is persisted before execution and completed state after')
  assert.equal(f.runs[0].runId, stableRunId(f.runs[0].plan))
})

test('future plan is persisted but does not call the model', async () => {
  const f = fixture({ now: 50 })
  const result = await f.scheduler.tick()
  assert.equal(result.status, 'waiting')
  assert.equal(f.runs.length, 0)
  assert.equal(f.state.action, 'wake')
})

test('failed run retains the same pending plan and stable run ID for idempotent retry', async () => {
  let calls = 0
  const f = fixture({
    runOnce: async () => {
      calls += 1
      if (calls === 1) throw new Error('model timed out after diary write')
      return { diaryRecorded: true }
    },
  })
  const first = await f.scheduler.tick()
  const second = await f.scheduler.tick()
  assert.equal(first.status, 'failed')
  assert.equal(second.status, 'completed')
  assert.equal(f.runs[0].runId, f.runs[1].runId)
  assert.equal(f.state.fired, true)
})

test('a run without diary confirmation is not marked complete', async () => {
  const f = fixture({ runOnce: async () => ({ diaryRecorded: false }) })
  const result = await f.scheduler.tick()
  assert.equal(result.status, 'failed')
  assert.equal(f.state.fired, undefined)
  assert.equal(f.state.action, 'wake')
})

test('single-flight guard refuses overlapping scheduler ticks', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ runOnce: async () => { await gate; return { diaryRecorded: true } } })
  const first = f.scheduler.tick()
  await new Promise(resolve => setImmediate(resolve))
  const second = await f.scheduler.tick()
  assert.equal(second.status, 'busy')
  release()
  assert.equal((await first).status, 'completed')
})

test('skip plans are passed through without being rewritten as wake plans', async () => {
  const plan = { action: 'skip', atMs: 100, windowKey: '2026-10-29|20:00–24:00', atText: '2026-10-29 20:10' }
  const f = fixture({ plan })
  const result = await f.scheduler.tick()
  assert.equal(result.status, 'completed')
  assert.equal(f.runs[0].action, 'skip')
})


test('autonomous scheduler defers due wake while external Agent holds a lease', async () => {
  const f = fixture({ shouldDefer: () => true })
  const result = await f.scheduler.tick()
  assert.equal(result.status, 'deferred')
  assert.equal(f.runs.length, 0)
  assert.equal(f.state.action, 'wake')
  assert.equal(f.state.fired, undefined)
})
