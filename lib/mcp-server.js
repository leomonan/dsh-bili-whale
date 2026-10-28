import readline from 'node:readline'

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
])

function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

/** MCP stdio subset: initialize, notifications/initialized, ping, tools/list, tools/call. */
export function createMcpProtocolHandler({ registry, serverInfo = { name: 'whale-agent', version: '0.1.0' } } = {}) {
  if (!registry || typeof registry.listTools !== 'function' || typeof registry.callTool !== 'function') {
    throw new TypeError('registry must implement listTools() and callTool()')
  }
  let negotiatedVersion = null
  let initialized = false

  async function handleMessage(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return rpcError(null, -32700, 'Parse error')
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return Object.prototype.hasOwnProperty.call(message ?? {}, 'id')
        ? rpcError(message.id, -32600, 'Invalid Request')
        : null
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    const id = hasId ? message.id : null
    const params = message.params ?? {}

    if (!hasId) {
      if (message.method === 'notifications/initialized' && negotiatedVersion) initialized = true
      // MCP notifications must never receive JSON-RPC responses.
      return null
    }

    if (message.method !== 'initialize' && !initialized) {
      return rpcError(id, -32002, 'Server not initialized')
    }

    try {
      if (message.method === 'initialize') {
        if (negotiatedVersion) return rpcError(id, -32600, 'Already initialized')
        const requested = params.protocolVersion
        if (typeof requested !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
          return rpcError(id, -32602, 'Unsupported MCP protocol version', {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          })
        }
        negotiatedVersion = requested
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiatedVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: 'Use Whale tools to inspect platform capabilities/content and coordinate local task handoff with an external Agent. Local task queue/lease changes are allowed; platform posting, commenting, messaging, favorites, and other account mutations are not exposed.',
          },
        }
      }

      if (message.method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} }
      }

      if (message.method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: await registry.listTools() } }
      }

      if (message.method === 'tools/call') {
        if (typeof params.name !== 'string' || !params.name) {
          return rpcError(id, -32602, 'tools/call requires params.name')
        }
        const result = await registry.callTool(params.name, params.arguments ?? {})
        return { jsonrpc: '2.0', id, result }
      }

      return rpcError(id, -32601, 'Method not found')
    } catch (error) {
      return rpcError(id, -32603, 'Internal error', {
        message: String(error?.message ?? error).slice(0, 500),
      })
    }
  }

  return { handleMessage, get initialized() { return initialized } }
}

export async function runStdioMcpServer({ registry, serverInfo, input = process.stdin, output = process.stdout } = {}) {
  const handler = createMcpProtocolHandler({ registry, serverInfo })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const response = await handler.handleMessage(line)
    if (response) output.write(JSON.stringify(response) + '\n')
  }
}
