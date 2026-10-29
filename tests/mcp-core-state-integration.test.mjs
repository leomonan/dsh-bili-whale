import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params })
const TOKEN = 'test-shared-core-token-0123456789abcdef0123456789'

test('real HTTP and stdio MCP entrypoints share the Core queue and private memory, not platform storage', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-cross-transport-'))
  const coreHome = path.join(temp, 'shared-core')
  const platformHome = path.join(temp, 'rss-data')
  const env = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    WHALE_PLATFORM: 'rss',
    WHALE_HOME: platformHome,
    WHALE_CORE_HOME: coreHome,
    WHALE_RSS_FEEDS: '[]',
    WHALE_MCP_HOST: '127.0.0.1',
    WHALE_MCP_PORT: '0',
    WHALE_MCP_AUTH_TOKEN: TOKEN,
  }
  const httpEntrypoint = fileURLToPath(new URL('../mcp/http-server.mjs', import.meta.url))
  const stdioEntrypoint = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
  const child = spawn(process.execPath, [httpEntrypoint], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ])
    }
    fs.rmSync(temp, { recursive: true, force: true })
  })

  let stderr = ''
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('HTTP MCP startup timed out: ' + stderr)), 10000)
    const finish = (error, value) => {
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
    child.once('error', error => finish(error))
    child.once('exit', code => finish(new Error('HTTP MCP exited ' + code + ': ' + stderr)))
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      const match = /authenticated HTTP MCP listening on (\{[^\r\n]+\})/.exec(stderr)
      if (match) {
        try { finish(null, JSON.parse(match[1])) } catch (error) { finish(error) }
      }
    })
  })
  const url = 'http://127.0.0.1:' + address.port + '/mcp'
  const request = (message, sessionId) => fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
    },
    body: JSON.stringify(message),
  })
  const init = await request(rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cross-transport-test', version: '1' },
  }))
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  assert.ok(sessionId)
  assert.equal((await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)).status, 202)

  const callHttp = async (id, name, args = {}) => {
    const res = await request(rpc(id, 'tools/call', { name, arguments: args }), sessionId)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result?.isError, undefined, JSON.stringify(body))
    return JSON.parse(body.result.content[0].text)
  }
  const submitted = await callHttp(2, 'whale_submit_task', {
    task: 'Check cross-transport identity',
    request_id: 'same-whale-01',
  })
  assert.equal(submitted.created, true)
  const claimed = await callHttp(3, 'whale_claim_task', { agent_id: 'http-client' })
  assert.equal(claimed.claimed, true)
  assert.equal(claimed.task.id, submitted.task.id)

  const stdioRequests = [
    rpc(10, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-client', version: '1' },
    }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(11, 'tools/call', { name: 'whale_list_tasks', arguments: { limit: 10 } }),
    rpc(12, 'tools/call', { name: 'whale_complete_task', arguments: {
      task_id: submitted.task.id,
      lease_token: claimed.leaseToken,
      result: 'Completed through stdio against the same persistent task.',
    } }),
  ]
  const stdio = spawnSync(process.execPath, [stdioEntrypoint], {
    input: stdioRequests.map(value => JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8',
    env,
    timeout: 15000,
  })
  assert.equal(stdio.error, undefined, stdio.stderr)
  assert.equal(stdio.status, 0, stdio.stderr)
  const responses = stdio.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(responses.length, 3, stdio.stdout)
  const list = JSON.parse(responses[1].result.content[0].text)
  assert.equal(list[0].id, submitted.task.id)
  assert.equal(list[0].status, 'leased')
  const completed = JSON.parse(responses[2].result.content[0].text)
  assert.equal(completed.completed, true)

  const after = await callHttp(4, 'whale_list_tasks', { limit: 10 })
  assert.equal(after[0].status, 'completed')
  const status = await callHttp(5, 'whale_status')
  assert.equal(status.externalControlLease, null)
  const publicDiary = await callHttp(6, 'whale_read_diary')
  assert.doesNotMatch(publicDiary.text, /Completed through stdio/)

  assert.equal(fs.existsSync(path.join(coreHome, 'whale-control.json')), true)
  assert.equal(fs.existsSync(path.join(coreHome, 'whale-agent-memory.jsonl')), true)
  assert.equal(fs.existsSync(path.join(platformHome, 'whale-control.json')), false)
  assert.equal(fs.existsSync(path.join(platformHome, 'whale-agent-memory.jsonl')), false)
  const journal = fs.readFileSync(path.join(coreHome, 'whale-agent-memory.jsonl'), 'utf8')
  assert.match(journal, /Completed through stdio/)
  assert.match(journal, /"visibility":"private"/)
})
