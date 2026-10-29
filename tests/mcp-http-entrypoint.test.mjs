import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('HTTP MCP refuses accidental plaintext non-loopback binding without explicit TLS-proxy trust', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-http-remote-guard-'))
  try {
    const entrypoint = fileURLToPath(new URL('../mcp/http-server.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [entrypoint], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        WHALE_PLATFORM: 'rss',
        WHALE_RSS_FEEDS: JSON.stringify([{ name: 'Test Feed', url: 'https://feeds.example.com/rss.xml' }]),
        WHALE_MCP_HOST: '0.0.0.0',
        WHALE_MCP_PORT: '8765',
        WHALE_MCP_AUTH_TOKEN: 'test-token-with-at-least-thirty-two-characters',
        WHALE_MCP_ALLOWED_ORIGINS: 'https://agent.example.com',
      },
    })
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Non-loopback HTTP MCP is plaintext/)
    assert.match(result.stderr, /WHALE_MCP_TRUST_PROXY_TLS=1/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
