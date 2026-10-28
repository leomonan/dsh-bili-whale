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
