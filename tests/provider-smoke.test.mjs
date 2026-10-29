import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('provider smoke test refuses to make a paid request without explicit opt-in', () => {
  const script = fileURLToPath(new URL('../scripts/provider-smoke.mjs', import.meta.url))
  const env = { ...process.env }
  delete env.WHALE_RUN_PAID_PROVIDER_SMOKE
  delete env.WHALE_MODEL_API_KEY
  delete env.OPENAI_API_KEY
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /explicit opt-in/)
  assert.doesNotMatch(result.stderr, /API key|secret/i)
})

test('provider smoke script requires opt-in before client configuration', () => {
  const script = fileURLToPath(new URL('../scripts/provider-smoke.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, WHALE_RUN_PAID_PROVIDER_SMOKE: '1', WHALE_MODEL_API_KEY: '', OPENAI_API_KEY: '', WHALE_MODEL: '' },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /WHALE_MODEL_API_KEY/)
})
