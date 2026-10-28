#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME, HOME, credentialsPath } from '../tools/lib/paths.mjs'
import { createBilibiliRuntime } from '../lib/bilibili-runtime.js'
import { createWhaleMcpTools } from '../lib/mcp-tools.js'
import { runStdioMcpServer } from '../lib/mcp-server.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platformRuntime = createBilibiliRuntime({
  dshHome: DSH_HOME,
  biliMjs: path.join(root, 'tools', 'bili.mjs'),
})
const registry = createWhaleMcpTools({
  platformRuntime,
  stateDir: DSH_HOME,
  homeDir: HOME,
  credentialsFile: credentialsPath,
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
