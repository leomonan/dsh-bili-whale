import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPlatformRuntime } from '../lib/platform-runtime-contract.js'

test('read-only platform runtime can omit social and live capabilities', () => {
  const rss = { id: 'rss', capabilities: { comments: { read: false }, messages: { read: false }, liveChat: { read: false } }, isPaused: () => false }
  assert.equal(assertPlatformRuntime(rss), rss)
})

test('enabled capabilities require concrete source methods', () => {
  assert.throws(() => assertPlatformRuntime({ id: 'broken', capabilities: { comments: { read: true } }, isPaused: () => false }), /comments.read requires/)
  assert.throws(() => assertPlatformRuntime({ id: 'broken', capabilities: { messages: { read: true } }, isPaused: () => false }), /messages.read requires/)
  assert.throws(() => assertPlatformRuntime({ id: 'broken', capabilities: { liveChat: { read: true } }, isPaused: () => false }), /liveChat.read requires/)
})

test('platform runtime requires a stable ID and pause gate', () => {
  assert.throws(() => assertPlatformRuntime({ capabilities: {}, isPaused: () => false }), /id and isPaused/)
  assert.throws(() => assertPlatformRuntime({ id: 'rss', capabilities: {} }), /id and isPaused/)
})
