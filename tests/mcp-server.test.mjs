import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpProtocolHandler } from '../lib/mcp-server.js'

function fixture() {
  const registry = {
    listTools: async () => [{ name: 'whale_status', inputSchema: { type: 'object' } }],
    async callTool(name, args) {
      return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }
    },
  }
  return createMcpProtocolHandler({ registry, serverInfo: { name: 'test-whale', version: '0.1.0' } })
}

async function initialize(handler, version = '2025-06-18') {
  const response = await handler.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } },
  }))
  return response
}

test('MCP initialize negotiates a supported protocol and requires initialized notification', async () => {
  const handler = fixture()
  const early = await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
  assert.equal(early.error.code, -32002)

  const response = await initialize(handler)
  assert.equal(response.result.protocolVersion, '2025-06-18')
  assert.equal(response.result.capabilities.tools.listChanged, false)
  assert.equal(response.result.serverInfo.name, 'test-whale')

  assert.equal(await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null)
  assert.equal(handler.initialized, true)
  const list = await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))
  assert.equal(list.result.tools[0].name, 'whale_status')
})

test('MCP tools/call forwards arguments and returns the tool result', async () => {
  const handler = fixture()
  await initialize(handler)
  await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  const response = await handler.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'whale_status', arguments: { detail: true } },
  }))
  assert.equal(response.id, 'call-1')
  assert.deepEqual(JSON.parse(response.result.content[0].text), { name: 'whale_status', args: { detail: true } })
})

test('MCP rejects unsupported versions and unknown methods with JSON-RPC errors', async () => {
  const handler = fixture()
  const version = await initialize(handler, 'unsupported-version')
  assert.equal(version.error.code, -32602)
  await initialize(handler)
  await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  const unknown = await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'not/a/method' }))
  assert.equal(unknown.error.code, -32601)
})

test('MCP malformed JSON returns parse error and notifications do not receive responses', async () => {
  const handler = fixture()
  assert.equal((await handler.handleMessage('{')).error.code, -32700)
  assert.equal(await handler.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' })), null)
})
