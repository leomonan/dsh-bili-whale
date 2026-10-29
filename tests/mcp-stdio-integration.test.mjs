import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('MCP stdio entrypoint negotiates, lists tools, and exits cleanly without platform credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-stdio-'))
  try {
    const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      DSH_HOME: path.join(dir, '.dsh'),
      DSH_NODE: process.execPath,
    }
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
      } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whale_status', arguments: {} } }),
    ].join('\n') + '\n'
    const result = spawnSync(process.execPath, [server], { input, env, encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(responses.length, 3)
    assert.equal(responses[0].result.protocolVersion, '2025-06-18')
    const names = responses[1].result.tools.map(tool => tool.name)
    assert.ok(names.includes('whale_status'))
    assert.ok(names.includes('whale_search_content'))
    assert.ok(names.includes('whale_read_content'))
    const status = JSON.parse(responses[2].result.content[0].text)
    assert.equal(status.platform, 'bilibili')
    assert.equal(status.credentialsConfigured, false)
    assert.equal(status.schedulerManaged, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test('MCP stdio can select RSS without Bilibili credentials and exposes only read-only content tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-rss-'))
  try {
    const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      WHALE_HOME: path.join(dir, '.whale-agent'),
      WHALE_PLATFORM: 'rss',
      WHALE_RSS_FEEDS: JSON.stringify([{ name: 'Example Feed', url: 'https://feeds.example.com/rss.xml' }]),
    }
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
      } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whale_status', arguments: {} } }),
    ].join('\n') + '\n'
    const result = spawnSync(process.execPath, [server], { input, env, encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(responses.length, 3)
    const names = responses[1].result.tools.map(tool => tool.name)
    assert.ok(names.includes('whale_search_content'))
    assert.ok(names.includes('whale_get_feed'))
    assert.ok(names.includes('whale_read_content'))
    assert.equal(names.some(name => /comment|message|publish|favorite|live/.test(name)), false)
    const status = JSON.parse(responses[2].result.content[0].text)
    assert.equal(status.platform, 'rss')
    assert.equal(status.credentialsRequired, false)
    assert.equal(status.credentialsConfigured, null)
    assert.equal(status.schedulerManaged, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test('modern stdio MCP accepts discover and tools/list directly without initialize', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-stdio-modern-'))
  try {
    const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'modern-client', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n'
    const result = spawnSync(process.execPath, [server], {
      input, encoding: 'utf8', timeout: 20_000,
      env: {
        ...process.env, HOME: dir, USERPROFILE: dir,
        WHALE_PLATFORM: 'rss',
        WHALE_RSS_FEEDS: JSON.stringify([{ name: 'Test Feed', url: 'https://feeds.example.com/rss.xml' }]),
      },
    })
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(responses.length, 2)
    assert.equal(responses[0].result.resultType, 'complete')
    assert.ok(responses[0].result.supportedVersions.includes('2026-07-28'))
    assert.equal(responses[1].result.tools[0].name, 'whale_status')
    assert.equal(responses[1].result.resultType, 'complete')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
