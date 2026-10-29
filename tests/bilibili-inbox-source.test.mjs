import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBilibiliInboxSource } from '../lib/bilibili-inbox-source.js'

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-inbox-source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialsFile = path.join(dir, 'credentials.json')
  fs.writeFileSync(credentialsFile, JSON.stringify({ sessdata: 'test-only-secret' }))
  const calls = []
  let paused = options.paused ?? false
  const source = createBilibiliInboxSource({
    credentialsFile,
    trafficGuardFactory: () => ({ pauseReason(headers) {
      calls.push({ kind: 'pause', headers })
      return paused ? 'test pause' : null
    } }),
    makeHeadersFn: credentials => ({ session: credentials.sessdata }),
    pullFeedFn: async (kind, options) => {
      calls.push({ kind: 'feed', feed: kind, options })
      return { items: [{ kind, id: kind + '-1', t: 100, headers: options.headers }] }
    },
  })
  return { dir, credentialsFile, calls, source, setPaused(value) { paused = value } }
}

test('comment inbox source reads replies only when scope is reply', async t => {
  const f = fixture(t)
  const items = await f.source.pollComments({ scope: 'reply' })
  assert.deepEqual(items.map(x => x.kind), ['reply'])
  const feedCalls = f.calls.filter(x => x.kind === 'feed')
  assert.deepEqual(feedCalls.map(x => x.feed), ['reply'])
  assert.deepEqual(feedCalls[0].options, { headers: { session: 'test-only-secret' }, pages: 1 })
})

test('comment inbox source reads replies and mentions for the combined scope', async t => {
  const f = fixture(t)
  const items = await f.source.pollComments({ scope: 'both' })
  assert.deepEqual(items.map(x => x.kind), ['reply', 'at'])
  assert.deepEqual(f.calls.filter(x => x.kind === 'feed').map(x => x.feed), ['reply', 'at'])
})

test('network pause is fail-closed for missing credentials and respects traffic guard', async t => {
  const f = fixture(t)
  assert.equal(f.source.isPaused(), false)
  f.setPaused(true)
  assert.equal(f.source.isPaused(), true)
  fs.unlinkSync(f.credentialsFile)
  assert.equal(f.source.isPaused(), true)
  await assert.rejects(f.source.pollComments(), /ENOENT/)
})
