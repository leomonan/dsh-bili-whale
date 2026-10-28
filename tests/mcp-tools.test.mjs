import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-tools-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateDir = path.join(dir, 'state')
  const homeDir = path.join(dir, 'home')
  fs.mkdirSync(stateDir)
  fs.mkdirSync(homeDir)
  const credentialsFile = path.join(homeDir, 'credentials.json')
  fs.writeFileSync(credentialsFile, JSON.stringify({ sessdata: 'secret-cookie-never-return-this' }))
  fs.writeFileSync(path.join(stateDir, 'whale-diary.md'), '# Public diary\nA remembered experience.\n')
  const calls = []
  const platformRuntime = options.platformRuntime ?? {
    id: 'test-platform',
    capabilities: { content: { search: true, feed: true, read: true } },
    isPaused: () => false,
    content: {
      async search(args) { calls.push(['search', args]); return 'search output' },
      async feed(args) { calls.push(['feed', args]); return 'feed output' },
      async read(args) { calls.push(['read', args]); return 'read output' },
    },
  }
  return {
    calls,
    credentialsFile,
    stateDir,
    platformRuntime,
    tools: createWhaleMcpTools({ platformRuntime, stateDir, homeDir, credentialsFile }),
  }
}

test('MCP tool list is capability-aware and exposes no public write actions', t => {
  const f = fixture(t)
  const names = f.tools.listTools().map(x => x.name)
  assert.ok(names.includes('whale_status'))
  assert.ok(names.includes('whale_search_content'))
  assert.ok(names.includes('whale_get_feed'))
  assert.ok(names.includes('whale_read_content'))
  assert.ok(names.includes('whale_read_diary'))
  assert.equal(names.some(x => /comment|publish|send_message|favorite/.test(x)), false)
})

test('status exposes no raw credentials and clearly identifies interactive-only mode', async t => {
  const f = fixture(t)
  const result = await f.tools.callTool('whale_status', {})
  const data = JSON.parse(result.content[0].text)
  assert.equal(data.platform, 'test-platform')
  assert.equal(data.credentialsConfigured, true)
  assert.equal(data.schedulerManaged, false)
  assert.equal(JSON.stringify(data).includes('secret-cookie-never-return-this'), false)
})

test('content tools validate inputs and call only the platform capability', async t => {
  const f = fixture(t)
  assert.equal((await f.tools.callTool('whale_search_content', { query: 'cats', page: 2 })).content[0].text, 'search output')
  assert.deepEqual(f.calls[0], ['search', { query: 'cats', page: 2 }])
  assert.equal((await f.tools.callTool('whale_get_feed', { limit: 4 })).content[0].text, 'feed output')
  assert.deepEqual(f.calls[1], ['feed', { limit: 4 }])
  assert.equal((await f.tools.callTool('whale_read_content', { content_id: 'BV1234567890' })).content[0].text, 'read output')
  assert.deepEqual(f.calls[2], ['read', { id: 'BV1234567890' }])
  assert.equal((await f.tools.callTool('whale_search_content', { query: ' ' })).isError, true)
  assert.equal((await f.tools.callTool('whale_get_feed', { limit: 99 })).isError, true)
  assert.equal((await f.tools.callTool('whale_read_content', { content_id: '--go' })).isError, true)
})

test('read-only platform receives no fabricated social capabilities', t => {
  const runtime = { id: 'rss', capabilities: { content: { search: true, feed: true, read: true } }, isPaused: () => false, content: {
    async search() { return 'search' }, async feed() { return 'feed' }, async read() { return 'read' },
  } }
  const f = fixture(t, { platformRuntime: runtime })
  const names = f.tools.listTools().map(x => x.name)
  assert.ok(names.includes('whale_search_content'))
  assert.equal(names.some(x => /comment|message|live|publish|favorite/.test(x)), false)
})

test('public diary is bounded and private diary is never exposed', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.stateDir, 'whale-diary-private.md'), 'PRIVATE SECRET')
  const result = await f.tools.callTool('whale_read_diary', { max_chars: 1000 })
  assert.match(result.content[0].text, /Public diary/)
  assert.doesNotMatch(result.content[0].text, /PRIVATE SECRET/)
})
