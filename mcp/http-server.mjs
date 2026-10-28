#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlatformRuntime } from '../lib/platform-loader.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createControlLeaseStore } from '../lib/control-lease-store.js'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { createMcpHttpServer } from '../lib/mcp-http-server.js'

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
  const { dataHome, credentialsFile, platformRuntime } = await loadPlatformRuntime({ root, userHome })
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

  const host = process.env.WHALE_MCP_HOST || '127.0.0.1'
  const port = Number(process.env.WHALE_MCP_PORT ?? 8765)
  const allowedOrigins = String(process.env.WHALE_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  if (!isLoopback && allowedOrigins.length === 0) {
    throw new Error('Set WHALE_MCP_ALLOWED_ORIGINS before binding HTTP MCP to a non-loopback host')
  }

  const app = createMcpHttpServer({
    registry,
    authToken: process.env.WHALE_MCP_AUTH_TOKEN,
    host,
    port,
    allowedOrigins,
  })
  const address = await app.listen()
  process.stderr.write('[whale-agent] authenticated HTTP MCP listening on ' + JSON.stringify(address) + '\n')

  await new Promise(resolve => {
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      void app.close().then(resolve, error => {
        process.stderr.write('[whale-agent] HTTP MCP shutdown error: ' + String(error?.message ?? error) + '\n')
        resolve()
      })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

main().catch(error => {
  process.stderr.write('[whale-agent] ' + String(error?.message ?? error).slice(0, 1000) + '\n')
  process.exitCode = 1
})
