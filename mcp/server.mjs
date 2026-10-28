#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRssRuntime } from '../lib/rss-runtime.js'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { runStdioMcpServer } from '../lib/mcp-server.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
const selectedPlatform = String(process.env.WHALE_PLATFORM ?? 'bilibili').trim().toLowerCase()

let dataHome
let credentialsFile = null
let platformRuntime

if (selectedPlatform === 'rss') {
  dataHome = process.env.WHALE_HOME || path.join(userHome, '.whale-agent')
  let feeds
  try {
    feeds = JSON.parse(process.env.WHALE_RSS_FEEDS ?? '[]')
  } catch {
    throw new Error('WHALE_RSS_FEEDS must be a JSON array of {name,url} objects')
  }
  platformRuntime = createRssRuntime({
    feeds,
    allowHttp: process.env.WHALE_RSS_ALLOW_HTTP === '1',
  })
} else if (selectedPlatform === 'bilibili') {
  dataHome = process.env.WHALE_HOME || process.env.DSH_HOME || path.join(userHome, '.dsh')
  // The legacy Bilibili CLI resolves its paths at module load; set the selected home before importing it.
  process.env.DSH_HOME = dataHome
  const [{ DSH_HOME, HOME, credentialsPath }, { createBilibiliRuntime }] = await Promise.all([
    import('../tools/lib/paths.mjs'),
    import('../lib/bilibili-runtime.js'),
  ])
  dataHome = DSH_HOME
  credentialsFile = credentialsPath
  platformRuntime = createBilibiliRuntime({
    dshHome: DSH_HOME,
    biliMjs: path.join(root, 'tools', 'bili.mjs'),
  })
} else {
  throw new Error('Unsupported WHALE_PLATFORM: ' + selectedPlatform + ' (supported: bilibili, rss)')
}

const memoryStore = createMemoryStore({ stateDir: dataHome })
const registry = createWhaleMcpTools({
  platformRuntime,
  stateDir: dataHome,
  homeDir: userHome,
  credentialsFile,
  memoryStore,
})

try {
  await runStdioMcpServer({
    registry,
    serverInfo: { name: 'whale-agent', version: '0.1.0' },
  })
} catch (error) {
  // stdout is reserved for MCP JSON-RPC messages; diagnostics go to stderr only.
  process.stderr.write('[whale-agent] ' + String(error?.message ?? error) + '\n')
  process.exitCode = 1
}
