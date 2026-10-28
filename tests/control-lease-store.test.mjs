import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryStore } from '../lib/memory-store.js'
import { createControlLeaseStore } from '../lib/control-lease-store.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-control-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = Date.parse('2026-10-29T00:00:00Z')
  const memoryStore = createMemoryStore({ stateDir: dir, now: () => new Date(now).toISOString() })
  const control = createControlLeaseStore({ stateDir: dir, memoryStore, now: () => now })
  return { dir, control, memoryStore, advance(ms) { now += ms } }
}

test('submit task is idempotent by request ID and public task listing hides lease tokens', t => {
  const f = fixture(t)
  const first = f.control.submitTask({ task: 'Research the latest RSS items', kind: 'research', requestedBy: 'chatgpt', requestId: 'req-1' })
  const duplicate = f.control.submitTask({ task: 'Different retry text', kind: 'research', requestedBy: 'chatgpt', requestId: 'req-1' })
  assert.equal(first.created, true)
  assert.equal(duplicate.duplicate, true)
  assert.equal(first.task.id, duplicate.task.id)
  assert.equal(f.control.listTasks().length, 1)
  assert.equal(JSON.stringify(f.control.listTasks()).includes('leaseToken'), false)
})

test('only one external Agent may hold a task lease at a time', t => {
  const f = fixture(t)
  const a = f.control.submitTask({ task: 'Task A' }).task
  f.control.submitTask({ task: 'Task B' })
  const claimed = f.control.claimTask({ agentId: 'codex', taskId: a.id, leaseSeconds: 600 })
  assert.equal(claimed.claimed, true)
  assert.ok(claimed.leaseToken.length >= 40)
  assert.equal(f.control.hasActiveLease(), true)
  const blocked = f.control.claimTask({ agentId: 'claude', leaseSeconds: 600 })
  assert.equal(blocked.claimed, false)
  assert.equal(blocked.activeTaskId, a.id)
  assert.equal(JSON.stringify(f.control.listTasks()).includes(claimed.leaseToken), false)
})

test('task completion records result in shared private memory and is idempotent', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Summarize two articles', kind: 'summarize' }).task
  const claim = f.control.claimTask({ agentId: 'chatgpt', taskId: task.id })
  const done = f.control.completeTask({ taskId: task.id, leaseToken: claim.leaseToken, result: 'Article one covers RSS; article two covers agents.' })
  assert.equal(done.completed, true)
  assert.equal(done.task.status, 'completed')
  assert.equal(f.control.hasActiveLease(), false)
  assert.match(f.memoryStore.readPrivateDiary().text, /Article one covers RSS/)
  assert.doesNotMatch(f.memoryStore.readPublicDiary().text, /Article one covers RSS/)
  const duplicate = f.control.completeTask({ taskId: task.id, leaseToken: claim.leaseToken, result: 'Article one covers RSS; article two covers agents.' })
  assert.equal(duplicate.duplicate, true)
})

test('invalid lease token cannot complete or release a task', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Review a design' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: task.id })
  assert.throws(() => f.control.completeTask({ taskId: task.id, leaseToken: 'wrong', result: 'no' }), /invalid/)
  assert.throws(() => f.control.releaseTask({ taskId: task.id, leaseToken: 'wrong' }), /invalid/)
  assert.equal(f.control.listTasks()[0].status, 'leased')
  assert.ok(claim.leaseToken)
})

test('release returns task to pending and expired leases are re-queued', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Review one article' }).task
  const first = f.control.claimTask({ agentId: 'codex', taskId: task.id, leaseSeconds: 60 })
  assert.equal(f.control.releaseTask({ taskId: task.id, leaseToken: first.leaseToken }).task.status, 'pending')
  const second = f.control.claimTask({ agentId: 'claude', taskId: task.id, leaseSeconds: 60 })
  f.advance(61_000)
  assert.equal(f.control.hasActiveLease(), false)
  const third = f.control.claimTask({ agentId: 'chatgpt', taskId: task.id, leaseSeconds: 60 })
  assert.equal(third.claimed, true)
  assert.notEqual(third.leaseToken, second.leaseToken)
})

test('control store rejects malformed persisted state instead of discarding tasks', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.dir, 'whale-control.json'), '{')
  assert.throws(() => f.control.listTasks(), /invalid/)
})
