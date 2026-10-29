import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('opt-in daemon completes one wake through a local mock model API without paid provider access', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-daemon-e2e-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const dataHome = path.join(home, '.whale-agent')
  fs.mkdirSync(dataHome, { recursive: true })
  const now = Date.now()
  const day = new Date(now).toLocaleDateString('sv-SE')
  fs.writeFileSync(path.join(dataHome, 'whale-night.json'), JSON.stringify({
    schema: 2,
    date: day,
    wakes: 0,
    wokeAt: null,
    usedCount: {},
    skippedWindows: [],
    action: 'wake',
    fired: false,
    woke: false,
    atMs: now - 5000,
    atText: day + ' 20:30',
    window: '20:00–24:00',
    windowKey: day + '|20:00–24:00',
    startsAt: now - 60_000,
    endsAt: now + 60_000,
    maxVideos: 5,
  }, null, 2))

  let requests = 0
  const modelServer = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests += 1
    assert.equal(req.headers.authorization, 'Bearer mock-api-key')
    const parsed = JSON.parse(body)
    assert.equal(parsed.model, 'test-fixed-model')
    let message
    if (requests === 1) {
      message = { role: 'assistant', content: null, tool_calls: [{
        id: 'call-read-private',
        type: 'function',
        function: { name: 'whale_read_private_diary', arguments: '{"max_chars":1000}' },
      }] }
    } else if (requests === 2) {
      message = { role: 'assistant', content: null, tool_calls: [{
        id: 'call-record-diary',
        type: 'function',
        function: { name: 'whale_record_diary', arguments: JSON.stringify({ entry: 'I completed a local mocked wake and saved a private memory.', mood: 'curious' }) },
      }] }
    } else {
      message = { role: 'assistant', content: 'The private diary entry was recorded.' }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      model: 'test-fixed-model',
      choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }))
  })
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address()
  const daemon = fileURLToPath(new URL('../daemon/whale-daemon.mjs', import.meta.url))
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WHALE_AUTONOMY_ENABLED: '1',
    WHALE_MODEL_API_KEY: 'mock-api-key',
    WHALE_MODEL: 'test-fixed-model',
    WHALE_MODEL_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1',
    WHALE_PLATFORM: 'rss',
    WHALE_HOME: dataHome,
    WHALE_RSS_FEEDS: JSON.stringify([{ name: 'Test feed', url: 'https://feeds.example.com/rss.xml' }]),
    WHALE_DAEMON_TICK_MS: '5000',
  }
  delete env.WHALE_CONFIG
  delete env.WHALE_CORE_HOME
  delete env.WHALE_MCP_AUTH_TOKEN
  const child = spawn(process.execPath, [daemon], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  let exited = false
  child.once('exit', () => { exited = true })
  t.after(async () => {
    if (!exited) {
      child.kill('SIGTERM')
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)])
    }
    await new Promise(resolve => modelServer.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const journal = path.join(dataHome, 'whale-agent-memory.jsonl')
  const scheduleFile = path.join(dataHome, 'whale-night.json')
  const deadline = Date.now() + 15_000
  const completed = () => {
    try { return JSON.parse(fs.readFileSync(scheduleFile, 'utf8')).fired === true } catch { return false }
  }
  while (Date.now() < deadline && (!fs.existsSync(journal) || requests < 3 || !completed()) && !exited) await delay(100)
  assert.equal(fs.existsSync(journal), true, 'daemon should record its private diary entry; stderr: ' + stderr)
  assert.equal(completed(), true, 'daemon should persist completed wake state; stderr: ' + stderr)
  const entries = fs.readFileSync(journal, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(entries.length, 1)
  assert.match(entries[0].entry, /local mocked wake/)
  assert.equal(entries[0].visibility, 'private')
  assert.equal(requests, 3)
  assert.match(stderr, /daemon started/)
  child.kill('SIGTERM')
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)])
})


test('real daemon restart reuses an already persisted private diary receipt without calling the model twice', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-daemon-restart-'))
  const home = path.join(dir, 'home')
  const coreHome = path.join(home, '.whale-agent')
  fs.mkdirSync(coreHome, { recursive: true })
  const now = Date.now()
  const day = new Date(now).toLocaleDateString('sv-SE')
  fs.writeFileSync(path.join(coreHome, 'whale-night.json'), JSON.stringify({
    schema: 2,
    date: day,
    wakes: 0,
    wokeAt: null,
    usedCount: {},
    skippedWindows: [],
    action: 'wake',
    fired: false,
    woke: false,
    atMs: now - 5_000,
    atText: day + ' 20:30',
    window: '20:00–24:00',
    windowKey: day + '|20:00–24:00',
    startsAt: now - 60_000,
    endsAt: now + 60_000,
    maxVideos: 5,
  }, null, 2))

  let modelRequests = 0
  const modelServer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {} // Consume request body; no external network access.
    modelRequests += 1
    if (modelRequests === 1) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'test-fixed-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'first-record', type: 'function', function: {
            name: 'whale_record_diary',
            arguments: JSON.stringify({ entry: 'A private reflection persisted before interruption.', mood: 'quiet' }),
          } }],
        } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }))
    } else {
      // The first process may ask for a final completion after diary persistence,
      // but that confirmation fails. A restarted process must make no more calls.
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('Simulated provider failure after durable diary write')
    }
  })
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const addr = modelServer.address()
  const daemonPath = fileURLToPath(new URL('../daemon/whale-daemon.mjs', import.meta.url))
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WHALE_PLATFORM: 'rss',
    WHALE_HOME: coreHome,
    WHALE_RSS_FEEDS: JSON.stringify([{ name: 'Test', url: 'https://feeds.example.com/rss.xml' }]),
    WHALE_AUTONOMY_ENABLED: '1',
    WHALE_MODEL_API_KEY: 'mock-api-key',
    WHALE_MODEL: 'test-fixed-model',
    WHALE_MODEL_BASE_URL: 'http://127.0.0.1:' + addr.port + '/v1',
    WHALE_DAEMON_TICK_MS: '5000',
  }
  delete env.WHALE_CONFIG
  delete env.WHALE_CORE_HOME
  const journalPath = path.join(coreHome, 'whale-agent-memory.jsonl')
  const schedulePath = path.join(coreHome, 'whale-night.json')
  const children = []
  async function stop(child) {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  function launch() {
    const child = spawn(process.execPath, [daemonPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.resume()
    children.push(child)
    return child
  }
  t.after(async () => {
    for (const child of children) await stop(child)
    await new Promise(resolve => modelServer.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const first = launch()
  const firstDeadline = Date.now() + 12_000
  while (!fs.existsSync(journalPath) && Date.now() < firstDeadline && first.exitCode === null) await delay(50)
  assert.equal(fs.existsSync(journalPath), true, 'First daemon should persist the diary before interruption')
  const pending = JSON.parse(fs.readFileSync(schedulePath, 'utf8'))
  assert.equal(pending.fired, false, 'First daemon must not mark wake complete before the model finishes')
  await stop(first)
  const requestsBeforeRestart = modelRequests
  assert.ok(requestsBeforeRestart >= 1)

  const second = launch()
  let completed = false
  const secondDeadline = Date.now() + 12_000
  while (!completed && Date.now() < secondDeadline && second.exitCode === null) {
    completed = JSON.parse(fs.readFileSync(schedulePath, 'utf8')).fired === true
    if (!completed) await delay(50)
  }
  assert.equal(completed, true, 'Restart should complete the persisted pending wake')
  assert.equal(modelRequests, requestsBeforeRestart, 'Restart must not invoke the model again')
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(journal.length, 1, 'Restart must not add another diary entry')
  assert.equal(journal[0].visibility, 'private')
  assert.match(journal[0].entry, /persisted before interruption/)
  await stop(second)
})
