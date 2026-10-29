import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
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

test('malformed request target returns 400 and leaves the server available', async t => {
  const f = await fixture(t)
  const { port } = new URL(f.base)
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    })
    let output = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { output += chunk })
    socket.once('end', () => resolve(output))
    socket.once('error', reject)
  })
  assert.match(raw, /^HTTP\/1\.1 400 /)
  const subsequent = await fetch(f.base, { method: 'POST' })
  assert.equal(subsequent.status, 401)
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

test('HTTP MCP CORS supports modern MCP preflight headers and exposes session response headers', async t => {
  const origin = 'https://agent.example.com'
  const f = await fixture(t, { allowedOrigins: [origin] })
  const preflight = await fetch(f.base, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  const allowedHeaders = preflight.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/)
  for (const header of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) {
    assert.ok(allowedHeaders.includes(header), 'preflight must allow ' + header)
  }

  const init = await f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), { origin })
  assert.equal(init.status, 200)
  const exposedHeaders = init.headers.get('access-control-expose-headers').toLowerCase().split(/,\s*/)
  assert.ok(exposedHeaders.includes('mcp-session-id'))
  assert.ok(exposedHeaders.includes('mcp-protocol-version'))
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


test('HTTP MCP does not expire or delete a session while a tool request is active', async t => {
  let now = 1_000
  let enteredResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slowRegistry = {
    listTools: async () => [{ name: 'slow_tool', inputSchema: { type: 'object', properties: {} } }],
    async callTool(name) {
      if (name === 'slow_tool') {
        enteredResolve()
        await gate
      }
      return { content: [{ type: 'text', text: name }] }
    },
  }
  const f = await fixture(t, { now: () => now, sessionTtlMs: 1000, registry: slowRegistry })
  const init = await f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
  const sessionId = init.headers.get('mcp-session-id')
  await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId })

  const pending = f.request(rpc(2, 'tools/call', { name: 'slow_tool', arguments: {} }), { 'mcp-session-id': sessionId })
  await entered
  now = 3000
  const deleted = await f.request(undefined, { 'mcp-session-id': sessionId }, 'DELETE')
  assert.equal(deleted.status, 409)
  const concurrent = await f.request(rpc(3, 'tools/list'), { 'mcp-session-id': sessionId })
  assert.equal(concurrent.status, 200)
  release()
  assert.equal((await pending).status, 200)

  now = 5001
  const expired = await f.request(rpc(4, 'tools/list'), { 'mcp-session-id': sessionId })
  assert.equal(expired.status, 404)
})


test('HTTP MCP enforces its configured session capacity', async t => {
  const f = await fixture(t, { maxSessions: 1 })
  const init = () => f.request(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
  const first = await init()
  assert.equal(first.status, 200)
  const sessionId = first.headers.get('mcp-session-id')
  const second = await init()
  assert.equal(second.status, 503)
  const deleted = await f.request(undefined, { 'mcp-session-id': sessionId }, 'DELETE')
  assert.equal(deleted.status, 204)
  const third = await init()
  assert.equal(third.status, 200)
})


const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const modernRpc = (id, method, params = {}) => rpc(id, method, { ...params, _meta: modernMeta })
const modernHeaders = (method, name) => ({
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': method,
  ...(name ? { 'mcp-name': name } : {}),
})

test('modern HTTP MCP discovers and calls tools without initialize or session IDs', async t => {
  const f = await fixture(t)
  const discovery = await f.request(modernRpc(1, 'server/discover'), modernHeaders('server/discover'))
  assert.equal(discovery.status, 200)
  assert.equal(discovery.headers.get('mcp-session-id'), null)
  const d = (await discovery.json()).result
  assert.equal(d.resultType, 'complete')
  assert.deepEqual(d.supportedVersions, ['2026-07-28'], 'handshake-era versions must not be advertised for stateless requests')
  assert.equal(d.capabilities.tools.listChanged, false)

  const listed = await f.request(modernRpc(2, 'tools/list'), modernHeaders('tools/list'))
  assert.equal(listed.status, 200)
  const tools = (await listed.json()).result
  assert.equal(tools.resultType, 'complete')
  assert.equal(tools.cacheScope, 'private')
  assert.equal(tools.tools[0].name, 'whale_status')
  const result = await f.request(
    modernRpc(3, 'tools/call', { name: 'whale_status', arguments: { test: true } }),
    modernHeaders('tools/call', 'whale_status'),
  )
  assert.equal(result.status, 200)
  const call = (await result.json()).result
  assert.equal(call.resultType, 'complete')
  assert.deepEqual(JSON.parse(call.content[0].text), { name: 'whale_status', args: { test: true } })
  assert.equal(f.app.sessionCount, 0)
})

test('modern HTTP validates mirrored routing headers before dispatching any tool', async t => {
  let calls = 0
  const guarded = {
    listTools: registry.listTools,
    callTool: async (...args) => { calls += 1; return registry.callTool(...args) },
  }
  const f = await fixture(t, { registry: guarded })
  for (const headers of [
    { 'mcp-method': 'tools/list' },
    { 'mcp-name': 'another_tool' },
    { 'mcp-protocol-version': '2026-01-01' },
  ]) {
    const response = await f.request(
      modernRpc(1, 'tools/call', { name: 'whale_status' }),
      { ...modernHeaders('tools/call', 'whale_status'), ...headers },
    )
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, -32020)
  }
  const missingName = await f.request(modernRpc(2, 'tools/call', { name: 'whale_status' }), modernHeaders('tools/call'))
  assert.equal(missingName.status, 400)
  assert.equal((await missingName.json()).error.code, -32020)
  assert.equal(calls, 0)
})

test('modern HTTP rejects unsupported protocol versions and methods without starting a session', async t => {
  const f = await fixture(t)
  const oldMeta = { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2026-01-01' }
  const unsupported = await f.request(
    rpc(1, 'tools/list', { _meta: oldMeta }),
    { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2026-01-01' },
  )
  assert.equal(unsupported.status, 400)
  assert.equal((await unsupported.json()).error.code, -32022)
  const unknown = await f.request(modernRpc(2, 'unsupported/method'), modernHeaders('unsupported/method'))
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, -32601)
  const deleted = await f.request(undefined, { 'mcp-protocol-version': '2026-07-28' }, 'DELETE')
  assert.equal(deleted.status, 405)
  assert.equal(f.app.sessionCount, 0)
})


test('modern HTTP accepts omitted clientInfo but rejects malformed clientInfo', async t => {
  const f = await fixture(t)
  const noIdentity = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  }
  const accepted = await f.request(
    rpc(1, 'server/discover', { _meta: noIdentity }),
    modernHeaders('server/discover'),
  )
  assert.equal(accepted.status, 200)
  assert.deepEqual((await accepted.json()).result.supportedVersions, ['2026-07-28'])

  for (const clientInfo of [null, 'bad', {}, { name: 'client' }, { name: 7, version: '1' }]) {
    const response = await f.request(
      rpc(2, 'server/discover', { _meta: { ...noIdentity, 'io.modelcontextprotocol/clientInfo': clientInfo } }),
      modernHeaders('server/discover'),
    )
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, -32602)
  }
})


test('modern HTTP rejects missing protocol-version header when modern routing headers are present', async t => {
  const f = await fixture(t)
  const response = await f.request(
    rpc(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } }),
    { 'mcp-method': 'tools/list' },
  )
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, -32020)
  assert.match(body.error.message, /Mcp-Protocol-Version/)
  assert.equal(f.app.sessionCount, 0)
})


test('modern HTTP decodes valid Base64 Mcp-Name and rejects malformed sentinel encodings', async t => {
  const unicodeRegistry = {
    listTools: async () => [{ name: 'é', inputSchema: { type: 'object', properties: {} } }],
    callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }),
  }
  const f = await fixture(t, { registry: unicodeRegistry })
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  }
  const requestBody = rpc(1, 'tools/call', { name: 'é', arguments: {} })
  requestBody.params._meta = meta
  const valid = await f.request(requestBody, {
    ...modernHeaders('tools/call', 'é'),
    'mcp-name': '=?base64?w6k=?=',
  })
  assert.equal(valid.status, 200)
  assert.equal(JSON.parse((await valid.json()).result.content[0].text).name, 'é')

  for (const malformed of ['=?base64?A?=', '=?base64?/w==?=', '=?base64?w6k===?=']) {
    const rejected = await f.request(requestBody, {
      ...modernHeaders('tools/call', 'é'),
      'mcp-name': malformed,
    })
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).error.code, -32020)
  }
})
