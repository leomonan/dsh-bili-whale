import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshSessionTransport } from '../lib/dsh-session-transport.js'
import { assertSessionTransport } from '../lib/session-transport.js'

test('DSH transport preserves create and prompt semantics at the host boundary', async () => {
  const calls = []
  const controller = {
    async create(input) {
      calls.push({ kind: 'create', input })
      return { sessionId: input.sessionId }
    },
    async prompt(input, signal) {
      calls.push({ kind: 'prompt', input, signal })
      return { accepted: true }
    },
  }
  const cwd = '/isolated/whale-work'
  const transport = createDshSessionTransport({ controller, cwd })
  assert.equal(assertSessionTransport(transport), transport)

  const request = { requestId: 'request-1', mode: 'queue', trace: 'keep-me' }
  await transport.ensureSession({ sessionId: 'session-create' })
  const controllerSignal = new AbortController().signal
  const content = [{ type: 'text', text: 'task payload' }]
  await transport.deliver({ request, sessionId: 'session-deliver', content, signal: controllerSignal })

  assert.deepEqual(calls[0], {
    kind: 'create',
    input: { sessionId: 'session-create', cwd },
  })
  assert.deepEqual(calls[1].input, {
    ...request,
    sessionId: 'session-deliver',
    content,
  })
  assert.equal(calls[1].signal, controllerSignal)
  assert.deepEqual(request, { requestId: 'request-1', mode: 'queue', trace: 'keep-me' })
})

test('invalid host-neutral transport fails closed at construction', () => {
  assert.throws(() => assertSessionTransport(null), /ensureSession\(\).*deliver\(\)/)
  assert.throws(() => assertSessionTransport({ ensureSession() {} }), /deliver\(\)/)
})
