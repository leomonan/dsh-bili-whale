import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadPlatformRuntime } from '../lib/platform-loader.js'

const feeds = JSON.stringify([{ name: 'Test feed', url: 'https://feeds.example.com/rss.xml' }])

test('RSS and other platform adapters share a stable Whale Core home by default', async () => {
  const userHome = path.join(path.sep, 'test-user')
  const runtime = await loadPlatformRuntime({
    platformId: 'rss',
    root: path.join(path.sep, 'repo'),
    userHome,
    env: { WHALE_RSS_FEEDS: feeds },
  })
  assert.equal(runtime.coreHome, path.join(userHome, '.whale-agent'))
  assert.equal(runtime.dataHome, path.join(userHome, '.whale-agent'))
  assert.equal(runtime.credentialsFile, null)
})

test('explicit WHALE_CORE_HOME is stable even when a platform has its own data directory', async () => {
  const userHome = path.join(path.sep, 'test-user')
  const coreHome = path.join(path.sep, 'shared-whale-core')
  const platformHome = path.join(path.sep, 'platform-data')
  const runtime = await loadPlatformRuntime({
    platformId: 'rss',
    root: path.join(path.sep, 'repo'),
    userHome,
    dataHome: platformHome,
    env: { WHALE_CORE_HOME: coreHome, WHALE_RSS_FEEDS: feeds },
  })
  assert.equal(runtime.coreHome, coreHome)
  assert.equal(runtime.dataHome, platformHome)
})
