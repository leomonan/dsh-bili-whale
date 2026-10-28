#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlatformRuntime } from '../lib/platform-loader.js'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createControlLeaseStore } from '../lib/control-lease-store.js'
import { runStdioMcpServer } from '../lib/mcp-server.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
const { dataHome, credentialsFile, platformRuntime } = await loadPlatformRuntime({
  root,
  userHome,
})

const memoryStore = createMemoryStore({ stateDir: dataHome })
const controlLeaseStore = createControlLeaseStore({ stateDir: dataHome, memoryStore })
const registry = createWhaleMcpTools({
  platformRuntime,
  stateDir: dataHome,
  homeDir: userHome,
  credentialsFile,
  memoryStore,
  controlLeaseStore,
  allowTaskHandoff: true,
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
