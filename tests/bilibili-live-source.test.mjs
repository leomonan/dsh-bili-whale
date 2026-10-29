import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createBilibiliLiveSource } from '../lib/bilibili-live-source.js'

test('live source builds the dedicated wait process with owner scope and required runtime options', () => {
  let captured
  const proc = { kill() {} }
  const env = { DSH_NODE: 'test-runtime' }
  const source = createBilibiliLiveSource({
    nodeExe: '/runtime/node',
    biliMjs: '/plugin/tools/bili.mjs',
    nodeEnv: env,
    execFileFn: (...args) => { captured = args; return proc },
  })
  const onExit = () => {}
  assert.equal(source.start({ room: '12345', scope: 'owner', operatorUid: '222', onExit }), proc)
  assert.equal(captured[0], '/runtime/node')
  assert.deepEqual(captured[1], [
    path.join('/plugin/tools/commands', 'danmaku-await.mjs'),
    '--room', '12345',
    '--operator-uid', '222',
  ])
  assert.deepEqual(captured[2], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env,
    cwd: '/plugin/tools',
  })
  assert.equal(captured[3], onExit)
})

test('live source does not add owner filter for a broader scope', () => {
  let captured
  const source = createBilibiliLiveSource({
    nodeExe: '/runtime/node',
    biliMjs: '/plugin/tools/bili.mjs',
    nodeEnv: {},
    execFileFn: (...args) => { captured = args; return {} },
  })
  source.start({ room: 55, scope: 'room', operatorUid: '222', onExit() {} })
  assert.deepEqual(captured[1], [
    path.join('/plugin/tools/commands', 'danmaku-await.mjs'),
    '--room', '55',
  ])
})

test('live source does not start without a Node runtime', () => {
  let called = false
  const source = createBilibiliLiveSource({
    nodeExe: null,
    biliMjs: '/plugin/tools/bili.mjs',
    nodeEnv: {},
    execFileFn: () => { called = true },
  })
  assert.equal(source.start({ room: 55, onExit() {} }), null)
  assert.equal(called, false)
})
