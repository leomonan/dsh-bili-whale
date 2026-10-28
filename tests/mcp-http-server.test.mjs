import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpHttpServer } from '../lib/mcp-http-server.js'

const TOKEN = 'test-token-with-at-least-thirty-two-characters'
const registry = {
  listTools: async () => [{ name: 'whale_status', inputSchema: { type: 'object', properties: {} } }],
  callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }),
}
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params })

async function fixture(t, options = {}) {
  const app = createMcpHttpServer({
    registry,
    authToken: TOKEN,
    host: '127.0.0.1',
    port: 0,
    ...options,
  })
  const address = await app.listen()
  const base = 'http://127.0.0.1:' + address.port + '/mcp'
  t.after(async () => app.close())
  const request = (body, headers = {}, method = 'POST') => fetch(base, {
    method,
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return { app, base, request }
}

test('HTTP MCP requires a strong bearer token and rejects unauthorized calls', async t => {
  assert.throws(() => createMcpHttpServer({ registry, authToken: 'short' }), /at least 32/)
  const f = await fixture(t)
  const response = await fetch(f.base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18' })),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('www-authenticate'), 'Bearer')
})

test('HTTP MCP initializes a session, handles notifications, lists tools, and closes the session', async t => {
  const f = await fixture(t)
  const init = await f.request(rpc(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
  }))
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  assert.ok(sessionId)
  assert.equal(init.headers.get('mcp-protocol-version'), '2025-06-18')
  assert.equal((await init.json()).result.protocolVersion, '2025-06-18')

  const notification = await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId })
  assert.equal(notification.status, 202)

  const listed = await f.request(rpc(2, 'tools/list'), { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).result.tools[0].name, 'whale_status')

  const deleted = await f.request(undefined, { 'mcp-session-id': sessionId }, 'DELETE')
  assert.equal(deleted.status, 204)
  const after = await f.request(rpc(3, 'tools/list'), { 'mcp-session-id': sessionId })
  assert.equal(after.status, 404)
})

test('HTTP MCP rejects missing sessions, protocol mismatches, and unsupported origins', async t => {
  const f = await fixture(t, { allowedOrigins: ['https://agent.example.com'] })
  const noSession = await f.request(rpc(2, 'tools/list'))
  assert.equal(noSession.status, 404)

  const deniedOrigin = await f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), { origin: 'https://evil.example' })
  assert.equal(deniedOrigin.status, 403)

  const init = await f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), { origin: 'https://agent.example.com' })
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId })
  const mismatch = await f.request(rpc(2, 'tools/list'), { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2024-11-05' })
  assert.equal(mismatch.status, 400)
})

test('HTTP MCP enforces body size and content type limits', async t => {
  const f = await fixture(t, { maxBodyBytes: 1024 })
  const wrongType = await fetch(f.base, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(wrongType.status, 415)
  const oversized = await f.request('{' + ' '.repeat(1200) + '}')
  assert.equal(oversized.status, 413)
})

test('HTTP MCP expires idle sessions', async t => {
  let now = 1_000_000
  const f = await fixture(t, { now: () => now, sessionTtlMs: 1000 })
  const init = await f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
  const sessionId = init.headers.get('mcp-session-id')
  await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId })
  now += 1001
  const result = await f.request(rpc(2, 'tools/list'), { 'mcp-session-id': sessionId })
  assert.equal(result.status, 404)
})
