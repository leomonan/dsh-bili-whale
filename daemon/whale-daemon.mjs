#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireProcessLock } from '../tools/lib/process-lock.mjs'
import { loadPlatformRuntime } from '../lib/platform-loader.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createControlLeaseStore } from '../lib/control-lease-store.js'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { createOpenAICompatibleModelClient } from '../lib/model-client.js'
import { createAgentOrchestrator } from '../lib/agent-orchestrator.js'
import { createAutonomousScheduler } from '../lib/autonomous-scheduler.js'

const DEFAULT_NIGHT = {
  windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
  skipChance: 0.3,
  minGapMin: 10,
  maxVideos: 5,
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('Invalid JSON configuration at ' + file + ': ' + String(error.message).slice(0, 200))
  }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Unable to read autonomous schedule state: ' + String(error.message).slice(0, 200))
  }
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
}

function personaText(userHome, configFile) {
  try {
    const text = fs.readFileSync(path.join(userHome, '.bili-ai', 'persona.md'), 'utf8').trim()
    if (text) return text.slice(0, 20_000)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read configured persona file')
  }
  const config = readJson(configFile)
  const persona = config.persona ?? {}
  return [
    persona.name ? 'Name: ' + String(persona.name) : '',
    persona.ownerTitle ? 'Address the user as: ' + String(persona.ownerTitle) : '',
    persona.selfClaim ? 'Self-reference: ' + String(persona.selfClaim) : '',
  ].filter(Boolean).join('\n').slice(0, 2_000)
}

async function main() {
  if (process.env.WHALE_AUTONOMY_ENABLED !== '1') {
    throw new Error('Autonomous mode is opt-in. Set WHALE_AUTONOMY_ENABLED=1 after configuring the model and platform.')
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
  const platformId = String(process.env.WHALE_PLATFORM ?? 'bilibili').trim().toLowerCase()
  const requestedHome = process.env.WHALE_HOME
    || (platformId === 'rss' ? path.join(userHome, '.whale-agent') : process.env.DSH_HOME || path.join(userHome, '.dsh'))
  const configFile = process.env.WHALE_CONFIG
    || path.join(requestedHome, platformId === 'bilibili' ? 'bili-whale.config.json' : 'whale-agent.config.json')
  if (platformId === 'bilibili') process.env.BILI_WHALE_CONFIG = configFile

  const { coreHome, dataHome, credentialsFile, platformRuntime } = await loadPlatformRuntime({
    platformId,
    root,
    userHome,
  })

  // Model configuration is explicit. No model call is attempted unless all required settings exist.
  const modelClient = createOpenAICompatibleModelClient()
  const memoryStore = createMemoryStore({ stateDir: coreHome, legacyPublicDiaryFile: path.join(dataHome, 'whale-diary.md') })
  const controlLeaseStore = createControlLeaseStore({ stateDir: coreHome, memoryStore })
  let activeRunId = null
  const registry = createWhaleMcpTools({
    platformRuntime,
    stateDir: dataHome,
    homeDir: userHome,
    credentialsFile,
    memoryStore,
    controlLeaseStore,
    allowTaskHandoff: true,
    allowLocalMemoryWrites: true,
    runIdProvider: () => activeRunId,
    schedulerManaged: true,
    mode: 'autonomous',
  })
  const orchestrator = createAgentOrchestrator({
    modelClient,
    toolRegistry: registry,
    platformId: platformRuntime.id,
    getPersona: () => personaText(userHome, configFile),
    setActiveRunId: id => { activeRunId = id },
  })

  const scheduleFile = path.join(coreHome, 'whale-night.json')
  const readNightConfig = () => {
    const config = readJson(configFile)
    const userNight = config.night && typeof config.night === 'object' ? config.night : {}
    const legacy = platformId === 'bilibili' ? readJson(path.join(dataHome, 'whale-night.config.json')) : {}
    return { ...DEFAULT_NIGHT, ...userNight, ...legacy }
  }
  const scheduler = createAutonomousScheduler({
    readConfig: readNightConfig,
    readState: () => readState(scheduleFile),
    writeState: value => writeState(scheduleFile, value),
    runOnce: ({ action, plan, runId, signal }) => orchestrator.runOnce({ action, plan, runId, signal }),
    shouldDefer: () => controlLeaseStore.hasActiveLease(),
    log: message => process.stderr.write(String(message) + '\n'),
  })

  fs.mkdirSync(coreHome, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireProcessLock(path.join(coreHome, 'whale-agent-daemon'))
  const configuredTick = Number(process.env.WHALE_DAEMON_TICK_MS ?? 60_000)
  if (!Number.isInteger(configuredTick) || configuredTick < 5_000 || configuredTick > 300_000) {
    await releaseLock()
    throw new Error('WHALE_DAEMON_TICK_MS must be an integer from 5000 to 300000')
  }

  const controller = new AbortController()
  let stopping = false
  let currentTick = null
  const launchTick = () => {
    if (stopping || currentTick) return
    currentTick = scheduler.tick({ signal: controller.signal })
      .catch(error => process.stderr.write('[whale-agent] scheduler error: ' + String(error?.message ?? error).slice(0, 500) + '\n'))
      .finally(() => { currentTick = null })
  }
  const timer = setInterval(launchTick, configuredTick)
  process.stderr.write('[whale-agent] daemon started; platform=' + platformRuntime.id + '; model=' + modelClient.model + '; coreHome=' + coreHome + '; platformDataHome=' + dataHome + '\n')
  launchTick()

  await new Promise(resolve => {
    const shutdown = () => {
      if (stopping) return
      stopping = true
      clearInterval(timer)
      controller.abort()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  if (currentTick) await currentTick
  await releaseLock()
  process.stderr.write('[whale-agent] daemon stopped cleanly\n')
}

main().catch(error => {
  process.stderr.write('[whale-agent] ' + String(error?.message ?? error).slice(0, 1000) + '\n')
  process.exitCode = 1
})
