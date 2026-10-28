import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionDelivery } from '../lib/session-delivery.js'

function fixture(t, options = {}) {
  const dshHome = options.dshHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'whale-session-delivery-'))
  if (!options.dshHome) t.after(() => fs.rmSync(dshHome, { recursive: true, force: true }))

  const calls = []
  const clock = { now: options.now ?? 1_000_000 }
  let personaText = options.persona ?? 'PERSONA v1'
  const transport = {
    async ensureSession({ sessionId }) {
      calls.push({ kind: 'create', input: { sessionId } })
      if (options.createError) throw options.createError
      return { sessionId }
    },
    async deliver({ request, sessionId, content, signal }) {
      const input = { ...request, sessionId, content }
      calls.push({ kind: 'prompt', input: structuredClone(input) })
      if (options.onPrompt) await options.onPrompt(input, signal, calls)
      if (options.promptError) throw options.promptError
      return { accepted: true }
    },
  }
  const delivery = createSessionDelivery({
    transport,
    stateDir: dshHome,
    personaPath: path.join(dshHome, 'persona.md'),
    diaryPaths: [path.join(dshHome, 'whale-diary.md'), path.join(dshHome, 'whale-diary-private.md')],
    sessionId: 'whale-main',
    config: () => (typeof options.config === 'function' ? options.config() : options.config) ?? { personaOncePerSession: true },
    persona: () => personaText,
    now: () => clock.now,
    log: message => calls.push({ kind: 'log', message }),
    onSession: id => calls.push({ kind: 'session', id }),
    isBusy: options.isBusy ?? (() => false),
  })
  return {
    dshHome, calls, clock, delivery,
    setPersona(value) { personaText = value },
    state() {
      return JSON.parse(fs.readFileSync(path.join(dshHome, 'whale-session.json'), 'utf8'))
    },
  }
}

const request = (requestId, text) => ({
  requestId,
  mode: 'queue',
  content: [{ type: 'text', text }],
})

test('first delivery creates the session, injects persona and diary recovery, and persists receipt state', async t => {
  const f = fixture(t)
  await f.delivery.send(request('wake-1', 'Wake task'))

  const create = f.calls.find(x => x.kind === 'create')
  const prompt = f.calls.find(x => x.kind === 'prompt')
  assert.equal(create.input.sessionId, 'whale-main')
  assert.deepEqual(create.input, { sessionId: 'whale-main' }, 'core transport does not know host-specific cwd')
  assert.equal(prompt.input.sessionId, 'whale-main')
  assert.match(prompt.input.content[0].text, /^PERSONA v1/)
  assert.match(prompt.input.content[0].text, /先读本地日记恢复记忆/)
  assert.match(prompt.input.content[0].text, /Wake task/)
  assert.equal(f.state().personaHash.length, 64)
  assert.equal(f.state().deliveredAt, f.clock.now)
})

test('persona is deduplicated per session but a changed persona is reinjected', async t => {
  const f = fixture(t)
  await f.delivery.send(request('task-1', 'one'))
  await f.delivery.send(request('task-2', 'two'))

  const prompts = f.calls.filter(x => x.kind === 'prompt')
  assert.match(prompts[0].input.content[0].text, /^PERSONA v1/)
  assert.doesNotMatch(prompts[1].input.content[0].text, /^PERSONA v1/)
  assert.match(prompts[1].input.content[0].text, /人设依据/)
  assert.doesNotMatch(prompts[1].input.content[0].text, /先读本地日记恢复记忆/)

  f.setPersona('PERSONA v2')
  await f.delivery.send(request('task-3', 'three'))
  const third = f.calls.filter(x => x.kind === 'prompt')[2]
  assert.match(third.input.content[0].text, /^PERSONA v2/)
})

test('retained delivery persists pending request before prompt and only matching ack clears it', async t => {
  let observedPending
  const f = fixture(t, {
    onPrompt(_input, _signal) {
      observedPending = f.state().pendingRequest
    },
  })
  await f.delivery.send(request('dm-receipt-1', 'owner DM'), undefined, { retainUntilAck: true })
  assert.equal(observedPending, 'dm-receipt-1')
  assert.equal(f.state().pendingRequest, 'dm-receipt-1')

  await f.delivery.confirm('different-receipt')
  assert.equal(f.state().pendingRequest, 'dm-receipt-1')
  await f.delivery.confirm('dm-receipt-1')
  assert.equal(Object.hasOwn(f.state(), 'pendingRequest'), false)
})

test('failed retained delivery keeps pending request for recovery and does not mark booted', async t => {
  const f = fixture(t, { promptError: new Error('host prompt failed') })
  await assert.rejects(
    f.delivery.send(request('dm-receipt-failed', 'owner DM'), undefined, { retainUntilAck: true }),
    /host prompt failed/,
  )
  assert.equal(f.state().pendingRequest, 'dm-receipt-failed')
  assert.equal(f.state().deliveredAt, undefined)

  // Simulate the host recovering; the pending request remains part of state.
  const next = fixture(t, { dshHome: f.dshHome })
  // The second instance reads the persisted state; confirm must not erase another receipt.
  await next.delivery.confirm('not-the-pending-request')
  assert.equal(f.state().pendingRequest, 'dm-receipt-failed')
})

test('delivery calls are serialized and do not overlap host prompts', async t => {
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const events = []
  const f = fixture(t, {
    onPrompt: async input => {
      const text = input.content.at(-1).text
      events.push('start:' + text.slice(-3))
      if (text.includes('first')) await firstGate
      events.push('end:' + text.slice(-3))
    },
  })

  const first = f.delivery.send(request('serial-1', 'first'))
  await new Promise(resolve => setImmediate(resolve))
  const second = f.delivery.send(request('serial-2', 'second'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.filter(x => x.startsWith('start:')).length, 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(events.length, 4)
  assert.match(events[0], /^start:/)
  assert.match(events[1], /^end:/)
  assert.match(events[2], /^start:/)
  assert.match(events[3], /^end:/)
})

test('session rotation preserves old session identity and creates a new session after configured age', async t => {
  const f = fixture(t, { config: () => ({ sessionRotateDays: 1, personaOncePerSession: true }) })
  await f.delivery.send(request('rotate-1', 'first session'))
  const oldId = f.state().id
  f.clock.now += 2 * 24 * 60 * 60 * 1000
  await f.delivery.send(request('rotate-2', 'second session'))

  const creates = f.calls.filter(x => x.kind === 'create')
  assert.equal(creates.length, 2)
  assert.notEqual(creates[1].input.sessionId, oldId)
  assert.equal(f.state().rotatedFrom, oldId)
  assert.equal(f.state().id, creates[1].input.sessionId)
})
