import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('public package export map exposes the reusable runtime without breaking legacy entrypoints', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.files.includes('scripts'), 'CLI scripts must be included in the published package files')
  assert.ok(pkg.files.includes('workers'), 'Worker entrypoints must be included in the published package files')
  for (const name of [
    './platform-runtime',
    './platform-loader',
    './rss-runtime',
    './mcp-server',
    './mcp-http-server',
    './memory',
    './control-lease',
    './model-client',
    './agent-orchestrator',
    './autonomous-scheduler',
  ]) {
    const target = pkg.exports[name]
    assert.equal(typeof target, 'string', name + ' should be exported')
    assert.equal(fs.existsSync(path.join(root, target)), true, name + ' should resolve to an existing file')
    const imported = await import('dsh-bili-whale/' + name.slice(2))
    assert.ok(imported && typeof imported === 'object', name + ' should be importable by package subpath')
  }
})


test('Wrangler example is non-production by default and does not bind a public route', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.example.jsonc'), 'utf8'))
  assert.equal(config.main, 'workers/whale-mcp-gateway.js')
  assert.equal(config.workers_dev, false)
  assert.equal(Object.hasOwn(config, 'routes'), false)
  assert.equal(Object.hasOwn(config, 'account_id'), false)
  assert.equal(config.vars.CF_ACCESS_TEAM_DOMAIN, 'your-team.cloudflareaccess.com')
  assert.match(config.vars.WHALE_MCP_ORIGIN_URL, /^https:\/\/replace-with-private-origin/)
})
