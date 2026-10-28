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
  const duplicate = f.control.submitTask({ task: 'Research the latest RSS items', kind: 'research', requestedBy: 'chatgpt', requestId: 'req-1' })
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


test('bounded queue prunes terminal history without dropping older pending tasks', t => {
  const f = fixture(t)
  const pending = []
  for (let i = 0; i < 99; i += 1) {
    pending.push(f.control.submitTask({ task: 'Pending task ' + i }).task)
  }
  const terminal = f.control.submitTask({ task: 'Will be completed' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: terminal.id })
  f.control.completeTask({ taskId: terminal.id, leaseToken: claim.leaseToken, result: 'Done.' })
  const next = f.control.submitTask({ task: 'New task after pruning' })
  assert.equal(next.created, true)
  const remaining = f.control.listTasks({ limit: 100 })
  assert.equal(remaining.length, 100)
  assert.ok(pending.every(task => remaining.some(item => item.id === task.id)))
  assert.equal(remaining.some(item => item.id === terminal.id), false)
})

test('completion fails closed when a retry conflicts with the result already in private memory', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Summarize a feed' }).task
  const claim = f.control.claimTask({ agentId: 'chatgpt', taskId: task.id })
  f.memoryStore.recordDiary({
    runId: 'handoff-' + task.id,
    entry: 'A different earlier result.',
    visibility: 'private',
    platform: 'external-agent',
  })
  assert.throws(() => f.control.completeTask({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    result: 'New conflicting result.',
  }), /conflicting or non-private handoff entry/)
  assert.equal(f.control.listTasks()[0].status, 'leased')
})


test('task idempotency key cannot be reused for a different payload', t => {
  const f = fixture(t)
  f.control.submitTask({ task: 'Research RSS', kind: 'research', requestedBy: 'chatgpt', requestId: 'same-key' })
  assert.throws(() => f.control.submitTask({
    task: 'Publish an announcement',
    kind: 'other',
    requestedBy: 'chatgpt',
    requestId: 'same-key',
  }), /different task parameters/)
  assert.equal(f.control.listTasks().length, 1)
})


test('completed task retries with the same lease must preserve the original result payload', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Summarize a page' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: task.id })
  f.control.completeTask({ taskId: task.id, leaseToken: claim.leaseToken, result: 'Original result.' })
  assert.throws(() => f.control.completeTask({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    result: 'Different retry result.',
  }), /different result payload/)
})


test('expired lease is persisted as pending even when a new submission hits queue capacity', t => {
  const f = fixture(t)
  const tasks = []
  for (let i = 0; i < 100; i += 1) {
    tasks.push(f.control.submitTask({ task: 'Queue task ' + i }).task)
  }
  const claimed = f.control.claimTask({ agentId: 'codex', taskId: tasks[0].id, leaseSeconds: 60 })
  f.advance(61_000)
  assert.throws(() => f.control.submitTask({ task: 'Must be rejected at capacity' }), /queue is full/)
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dir, 'whale-control.json'), 'utf8'))
  assert.equal(persisted.tasks.find(item => item.id === tasks[0].id).status, 'pending')
  assert.ok(claimed.leaseToken)
})


test('handoff completion refuses to reuse a public diary entry for private task memory', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Summarize an article' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: task.id })
  const expected = 'External Agent task (' + task.kind + '): ' + task.task.slice(0, 200) + '\n\nResult:\nA result that should remain private.'
  f.memoryStore.recordDiary({
    runId: 'handoff-' + task.id,
    entry: expected,
    visibility: 'public',
    platform: 'external-agent',
  })
  assert.throws(() => f.control.completeTask({
    taskId: task.id,
    leaseToken: claim.leaseToken,
    result: 'A result that should remain private.',
  }), /non-private handoff entry/)
  assert.equal(f.control.listTasks()[0].status, 'leased')
})


test('external Agent can renew an active lease before expiry and finish the task', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Analyze a long article' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: task.id, leaseSeconds: 60 })
  f.advance(40_000)
  const renewed = f.control.renewTask({ taskId: task.id, leaseToken: claim.leaseToken, leaseSeconds: 180 })
  assert.equal(renewed.renewed, true)
  assert.equal(Date.parse(renewed.task.lease.expiresAt), Date.parse(renewed.task.lease.renewedAt) + 180_000)
  f.advance(61_000)
  assert.equal(f.control.hasActiveLease(), true)
  const completed = f.control.completeTask({ taskId: task.id, leaseToken: claim.leaseToken, result: 'Long analysis complete.' })
  assert.equal(completed.completed, true)
})

test('expired or invalid task leases cannot be renewed', t => {
  const f = fixture(t)
  const task = f.control.submitTask({ task: 'Long task' }).task
  const claim = f.control.claimTask({ agentId: 'codex', taskId: task.id, leaseSeconds: 60 })
  assert.throws(() => f.control.renewTask({ taskId: task.id, leaseToken: 'wrong', leaseSeconds: 600 }), /invalid/)
  f.advance(61_000)
  assert.throws(() => f.control.renewTask({ taskId: task.id, leaseToken: claim.leaseToken, leaseSeconds: 600 }), /no active control lease/)
})
