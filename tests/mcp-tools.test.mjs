import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createControlLeaseStore } from '../lib/control-lease-store.js'

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


test('daemon-only diary tools are not exposed by the public MCP registry', async t => {
  const f = fixture(t)
  const memoryStore = createMemoryStore({ stateDir: f.stateDir })
  const publicRegistry = createWhaleMcpTools({
    platformRuntime: f.platformRuntime,
    stateDir: f.stateDir,
    homeDir: path.dirname(f.credentialsFile),
    credentialsFile: f.credentialsFile,
    memoryStore,
  })
  const publicNames = publicRegistry.listTools().map(x => x.name)
  assert.equal(publicNames.includes('whale_record_diary'), false)
  assert.equal(publicNames.includes('whale_read_private_diary'), false)
  assert.equal(publicNames.includes('whale_search_private_memory'), false)

  let activeRunId = null
  const daemonRegistry = createWhaleMcpTools({
    platformRuntime: f.platformRuntime,
    stateDir: f.stateDir,
    homeDir: path.dirname(f.credentialsFile),
    credentialsFile: f.credentialsFile,
    memoryStore,
    allowLocalMemoryWrites: true,
    runIdProvider: () => activeRunId,
    schedulerManaged: true,
    mode: 'autonomous',
  })
  const daemonNames = daemonRegistry.listTools().map(x => x.name)
  assert.ok(daemonNames.includes('whale_record_diary'))
  assert.ok(daemonNames.includes('whale_read_private_diary'))
  assert.ok(daemonNames.includes('whale_search_private_memory'))

  assert.equal((await daemonRegistry.callTool('whale_record_diary', { entry: 'No active run.' })).isError, true)
  activeRunId = 'daemon-run-1'
  const recorded = await daemonRegistry.callTool('whale_record_diary', { entry: 'Private autonomous reflection.', mood: 'curious' })
  assert.equal(JSON.parse(recorded.content[0].text).recorded, true)
  const privateRead = await daemonRegistry.callTool('whale_read_private_diary', { max_chars: 1000 })
  assert.match(privateRead.content[0].text, /Private autonomous reflection/)
  const recalled = await daemonRegistry.callTool('whale_search_private_memory', { query: 'Private autonomous', limit: 5 })
  assert.match(recalled.content[0].text, /Private autonomous reflection/)
  activeRunId = 'daemon-run-public-attempt'
  const forcedPrivate = await daemonRegistry.callTool('whale_record_diary', {
    entry: 'A model attempted to request public visibility.',
    visibility: 'public',
  })
  assert.equal(JSON.parse(forcedPrivate.content[0].text).visibility, 'private')
  const publicRead = await publicRegistry.callTool('whale_read_diary', { max_chars: 1000 })
  assert.doesNotMatch(publicRead.content[0].text, /Private autonomous reflection/)
  assert.doesNotMatch(publicRead.content[0].text, /attempted to request public visibility/)
  const status = JSON.parse((await daemonRegistry.callTool('whale_status', {})).content[0].text)
  assert.equal(status.schedulerManaged, true)
  assert.equal(status.mode, 'autonomous')
  assert.equal(status.diaryAvailable, true)
})


test('MCP external Agent can claim and complete a local task without platform writes', async t => {
  const f = fixture(t)
  const memoryStore = createMemoryStore({ stateDir: f.stateDir })
  const controlLeaseStore = createControlLeaseStore({ stateDir: f.stateDir, memoryStore })
  const registry = createWhaleMcpTools({
    platformRuntime: f.platformRuntime,
    stateDir: f.stateDir,
    homeDir: path.dirname(f.credentialsFile),
    credentialsFile: f.credentialsFile,
    memoryStore,
    controlLeaseStore,
    allowTaskHandoff: true,
  })
  const names = registry.listTools().map(x => x.name)
  assert.ok(names.includes('whale_submit_task'))
  assert.ok(names.includes('whale_claim_task'))
  assert.ok(names.includes('whale_complete_task'))
  assert.ok(names.includes('whale_release_task'))
  assert.equal(names.some(x => /publish|send_message|comment_write|favorite_write/.test(x)), false)

  const submitted = JSON.parse((await registry.callTool('whale_submit_task', {
    task: 'Review the latest two RSS articles',
    kind: 'review',
    requested_by: 'chatgpt',
    request_id: 'handoff-request-1',
  })).content[0].text)
  assert.equal(submitted.created, true)
  const claimed = JSON.parse((await registry.callTool('whale_claim_task', {
    agent_id: 'codex',
    task_id: submitted.task.id,
    lease_seconds: 600,
  })).content[0].text)
  assert.equal(claimed.claimed, true)
  const token = claimed.leaseToken
  const status = JSON.parse((await registry.callTool('whale_status', {})).content[0].text)
  assert.equal(status.externalControlLease.taskId, submitted.task.id)
  assert.equal(JSON.stringify(status).includes(token), false)

  const completed = JSON.parse((await registry.callTool('whale_complete_task', {
    task_id: submitted.task.id,
    lease_token: token,
    result: 'The first article explains feed parsing; the second discusses Agent memory.',
  })).content[0].text)
  assert.equal(completed.completed, true)
  assert.equal(completed.task.status, 'completed')
  assert.match(memoryStore.readPrivateDiary().text, /Agent memory/)
  assert.doesNotMatch(memoryStore.readPublicDiary().text, /Agent memory/)
  assert.equal(controlLeaseStore.hasActiveLease(), false)
})
