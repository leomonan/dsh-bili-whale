import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBilibiliRuntime } from '../lib/bilibili-runtime.js'

test('Bilibili runtime composes inbox, DM and live adapters over one configured runtime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bili-runtime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const credentialsFile = path.join(dir, 'credentials.json')
  fs.writeFileSync(credentialsFile, JSON.stringify({ sessdata: 'test-session' }))
  const calls = []
  const environment = { DSH_HOME: dir }
  const proc = { kill() {} }
  const runtime = createBilibiliRuntime({
    dshHome: dir,
    biliMjs: '/plugin/tools/bili.mjs',
    resolveNodeRuntimeFn: home => { assert.equal(home, dir); return '/runtime/node' },
    nodeEnvFn: home => { assert.equal(home, dir); return environment },
    execFileFn: (...args) => {
      calls.push(args)
      const callback = args.at(-1)
      if (args[1].includes('dm-await')) queueMicrotask(() => callback(null, JSON.stringify({ hit: false }), ''))
      return proc
    },
    inboxOptions: {
      credentialsFile,
      makeHeadersFn: credentials => ({ session: credentials.sessdata }),
      trafficGuardFactory: () => ({ pauseReason: () => null }),
      pullFeedFn: async kind => ({ items: [{ kind, id: kind + '-1', t: 100 }] }),
    },
  })

  assert.equal(runtime.id, 'bilibili')
  assert.deepEqual(runtime.capabilities, { comments: { read: true }, messages: { read: true }, liveChat: { read: true } })
  assert.equal(runtime.isPaused(), false)
  assert.deepEqual((await runtime.comments.pollComments({ scope: 'reply' })).map(x => x.kind), ['reply'])
  assert.deepEqual(await runtime.messages.pollOnce(), { hit: false })
  assert.deepEqual(calls[0][0], '/runtime/node')
  assert.deepEqual(calls[0][1], ['/plugin/tools/bili.mjs', 'dm-await', '--once', '--json', '--peek'])
  assert.equal(calls[0][2].timeout, 120_000)
  assert.equal(calls[0][2].env, environment)

  const onExit = () => {}
  assert.equal(runtime.liveChat.start({ room: '987', scope: 'room', onExit }), proc)
  assert.deepEqual(calls[1][1], [
    path.join('/plugin/tools/commands', 'danmaku-await.mjs'),
    '--room', '987',
  ])
  assert.equal(calls[1][2].cwd, '/plugin/tools')
})

test('Bilibili runtime fails at construction if the required Node runtime cannot be resolved', () => {
  assert.throws(() => createBilibiliRuntime({
    dshHome: '/profile',
    biliMjs: '/plugin/tools/bili.mjs',
    resolveNodeRuntimeFn: () => { throw new Error('runtime unavailable') },
  }), /runtime unavailable/)
})
