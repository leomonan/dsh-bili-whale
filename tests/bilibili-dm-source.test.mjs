import test from 'node:test'
import assert from 'node:assert/strict'
import { createBilibiliDmSource } from '../lib/bilibili-dm-source.js'

test('empty DM inbox is a normal result for exit code 1', async () => {
  const calls = []
  const source = createBilibiliDmSource({ runCommand: async args => {
    calls.push(args)
    return { code: 1, out: JSON.stringify({ hit: false }), err: '' }
  } })
  assert.deepEqual(await source.pollOnce(), { hit: false })
  assert.deepEqual(calls, [['dm-await', '--once', '--json', '--peek']])
})

test('DM hit requires a receipt and preserves normalized message fields', async () => {
  const source = createBilibiliDmSource({ runCommand: async () => ({
    code: 0,
    out: JSON.stringify({ hit: true, receipt: 'receipt-1', name: 'Owner', mid: '222', text: 'hello' }),
    err: '',
  }) })
  assert.deepEqual(await source.pollOnce(), {
    hit: true, receipt: 'receipt-1', name: 'Owner', mid: '222', text: 'hello',
  })
  const missingReceipt = createBilibiliDmSource({ runCommand: async () => ({
    code: 0, out: JSON.stringify({ hit: true, text: 'hello' }), err: '',
  }) })
  await assert.rejects(missingReceipt.pollOnce(), /没有回执/)
})

test('DM source distinguishes command failure from an empty inbox and malformed output', async () => {
  const failed = createBilibiliDmSource({ runCommand: async () => ({ code: 3, out: '', err: 'CLI failed' }) })
  await assert.rejects(failed.pollOnce(), /CLI failed/)
  const malformed = createBilibiliDmSource({ runCommand: async () => ({ code: 1, out: 'not-json', err: '' }) })
  await assert.rejects(malformed.pollOnce(), /返回无效结果/)
})

test('DM acknowledgement uses the exact receipt and returns command outcome', async () => {
  const calls = []
  const source = createBilibiliDmSource({ runCommand: async args => {
    calls.push(args)
    return { ok: true, code: 0 }
  } })
  assert.deepEqual(await source.ack('receipt-42'), { ok: true, code: 0 })
  assert.deepEqual(calls, [['dm-await', '--ack', 'receipt-42']])
  await assert.rejects(source.ack(''), /receipt is required/)
})
