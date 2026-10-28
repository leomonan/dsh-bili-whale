import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBilibiliWorkflows } from '../lib/bilibili-workflows.js'

test('Bilibili wake workflow uses injected config/home paths and preserves platform-specific instructions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-workflows-'))
  try {
    const privateDir = path.join(home, '.bili-ai')
    fs.mkdirSync(privateDir, { recursive: true })
    const configFile = path.join(home, 'bili-whale.config.json')
    fs.writeFileSync(configFile, JSON.stringify({ share: { via: 'comment' }, diary: { push: false } }))
    const workflows = createBilibiliWorkflows({ configFile, homeDir: home })
    const text = workflows.wakePrompt({ atText: '12:00', window: '12:00–13:00', withinWindow: '第 1/1 次' }, '', 7, 'comment')
    assert.match(text, /feed 选题（≤7 条）/)
    assert.match(text, /走【评论区 @】/)
    assert.doesNotMatch(text, /走【私信】/)
    assert.match(text, /主人关掉了推送/)
    assert.match(text, /不要走私信 dm/)
    assert.ok(fs.existsSync(path.join(privateDir, 'silence-seen.json')))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('Bilibili wake workflow requires explicit paths instead of silently using host-global paths', () => {
  assert.throws(() => createBilibiliWorkflows(), /configFile and homeDir/)
})
