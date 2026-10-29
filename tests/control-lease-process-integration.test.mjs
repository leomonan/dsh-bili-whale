import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createControlLeaseStore } from '../lib/control-lease-store.js'

test('separate Agent processes compete for one durable lease and restart can reclaim expiration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cross-process-lease-'))
  const memoryStore = { recordDiary: () => { throw new Error('No completion performed in this test') } }
  const control = createControlLeaseStore({ stateDir: dir, memoryStore })
  control.submitTask({ task: 'Independent task A', requestId: 'concurrent-a' })
  control.submitTask({ task: 'Independent task B', requestId: 'concurrent-b' })
  const gate = path.join(dir, 'release-contenders')
  const script = path.join(dir, 'claim.mjs')
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../lib/control-lease-store.js', import.meta.url))).href
  fs.writeFileSync(script, [
    "import fs from 'node:fs'",
    "import { createControlLeaseStore } from " + JSON.stringify(moduleUrl),
    "const [stateDir, gate, agentId] = process.argv.slice(2)",
    "const control = createControlLeaseStore({stateDir, memoryStore: {recordDiary() { throw new Error('No completion') } }})",
    "process.stdout.write('READY\\n')",
    "for (let i = 0; i < 1000 && !fs.existsSync(gate); i++) await new Promise(resolve => setTimeout(resolve, 10))",
    "if (!fs.existsSync(gate)) throw new Error('Startup barrier was never released')",
    "try { process.stdout.write('RESULT ' + JSON.stringify(control.claimTask({agentId, leaseSeconds: 60})) + '\\n') }",
    "catch (error) { process.stdout.write('ERROR ' + String(error.message) + '\\n') }",
  ].join('\n'))

  const children = []
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function start(agentId) {
    const child = spawn(process.execPath, [script, dir, gate, agentId], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = ''
    let stderr = ''
    let onReady
    const ready = new Promise(resolve => { onReady = resolve })
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.includes('READY\n')) onReady()
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve({ output, stderr }) : reject(new Error(agentId + ' exited ' + code + ': ' + stderr)))
    })
    return { ready, done }
  }
  const a = start('codex')
  const b = start('claude')
  await Promise.race([
    Promise.all([a.ready, b.ready]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Contenders did not start')), 10_000)),
  ])
  fs.writeFileSync(gate, 'go\n')
  const results = await Promise.all([a.done, b.done])
  const lines = results.flatMap(r => r.output.split(/\r?\n/))
  const claims = lines.filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)))
  const successes = claims.filter(result => result.claimed === true)
  assert.equal(successes.length, 1, 'Exactly one process must obtain a lease: ' + JSON.stringify(lines))
  const listed = control.listTasks()
  assert.equal(listed.filter(task => task.status === 'leased').length, 1)
  assert.equal(listed.filter(task => task.status === 'pending').length, 1)
  assert.equal(control.hasActiveLease(), true)

  // A new store instance, standing in for a restart, must recognize expiry
  // from the persisted lease timestamp, not from in-memory owner state.
  const restarted = createControlLeaseStore({ stateDir: dir, memoryStore, now: () => Date.now() + 61_000 })
  assert.equal(restarted.hasActiveLease(), false)
  const reclaimed = restarted.claimTask({ agentId: 'replacement', leaseSeconds: 60 })
  assert.equal(reclaimed.claimed, true)
  assert.equal(restarted.hasActiveLease(), true)
})
