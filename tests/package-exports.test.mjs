import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('public package export map exposes the reusable runtime without breaking legacy entrypoints', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
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
  }
})
