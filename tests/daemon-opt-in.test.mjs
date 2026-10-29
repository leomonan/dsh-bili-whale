import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('autonomous daemon refuses to start unless explicit opt-in is enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-daemon-opt-in-'))
  try {
    const daemon = fileURLToPath(new URL('../daemon/whale-daemon.mjs', import.meta.url))
    const env = { ...process.env, HOME: dir, USERPROFILE: dir }
    delete env.WHALE_AUTONOMY_ENABLED
    delete env.WHALE_MODEL_API_KEY
    delete env.OPENAI_API_KEY
    delete env.WHALE_MODEL
    const result = spawnSync(process.execPath, [daemon], { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Autonomous mode is opt-in/)
    assert.doesNotMatch(result.stderr, /daemon started/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
