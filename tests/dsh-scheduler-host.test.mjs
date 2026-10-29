import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDshSchedulerHost } from '../lib/dsh-scheduler-host.js'

test('DSH host adapter exposes transport and delivery availability', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dsh-host-'))
  try {
    const controller = { create: async () => {}, prompt: async () => {} }
    const host = createDshSchedulerHost({ ctx: { sessionController: controller }, dshHome: dir, cwd: dir, sessionId: 'session-a' })
    assert.equal(host.canDeliver(), true)
    assert.equal(typeof host.transport.ensureSession, 'function')
    assert.equal(typeof host.transport.deliver, 'function')
    assert.equal(host.isSessionBusy(), false)
    host.setSessionId('session-b')
    assert.equal(host.isSessionBusy(), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('DSH host adapter reports active session files as busy and switches cache on rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dsh-host-'))
  try {
    const sessionDir = path.join(dir, 'sessions', 'session-a')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'test')
    const host = createDshSchedulerHost({ ctx: { sessionController: { create: async () => {}, prompt: async () => {} } }, dshHome: dir, cwd: dir, sessionId: 'session-a' })
    assert.equal(host.isSessionBusy(), 'still-working')
    host.setSessionId('session-b')
    assert.equal(host.isSessionBusy(), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('DSH host adapter fails closed when host options are missing', () => {
  assert.throws(() => createDshSchedulerHost({ ctx: {} }), /ctx and dshHome/)
  const host = createDshSchedulerHost({ ctx: {}, dshHome: '/tmp/whale-host-test' })
  assert.equal(host.canDeliver(), false)
})
