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

export const MODERN_MCP_VERSION = '2026-07-28'
const MODERN_META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const MODERN_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const MODERN_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** Modern MCP shares the same Whale tool registry but has no handshake or transport session. */
export function createModernMcpProtocolHandler({ registry, serverInfo = { name: 'whale-agent', version: '0.1.0' } } = {}) {
  if (!registry || typeof registry.listTools !== 'function' || typeof registry.callTool !== 'function') {
    throw new TypeError('registry must implement listTools() and callTool()')
  }

  async function handleMessage(input) {
    let message
    try { message = typeof input === 'string' ? JSON.parse(input) : input } catch {
      return rpcError(null, -32700, 'Parse error')
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, 'Invalid Request')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    if (!hasId) return null
    const id = message.id
    const params = message.params
    const meta = params && typeof params === 'object' && !Array.isArray(params) ? params._meta : null
    const version = meta?.[MODERN_META_VERSION]
    if (version !== MODERN_MCP_VERSION) {
      return rpcError(id, -32022, 'Unsupported protocol version', {
        supported: [MODERN_MCP_VERSION],
        requested: typeof version === 'string' ? version : '',
      })
    }
    const clientInfo = meta?.[MODERN_CLIENT_INFO]
    const clientCapabilities = meta?.[MODERN_CLIENT_CAPABILITIES]
    if (!meta || (clientInfo !== undefined && (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)
        || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string'))
        || !clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) {
      return rpcError(id, -32602, 'Modern MCP requires clientCapabilities in _meta; clientInfo is optional but must be valid when present')
    }
    const serverMeta = { 'io.modelcontextprotocol/serverInfo': serverInfo }
    const response = result => ({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete', _meta: serverMeta } })
    try {
      if (message.method === 'server/discover') return response({
        // Legacy revisions require initialize and must never be advertised as stateless.
        supportedVersions: [MODERN_MCP_VERSION],
        capabilities: { tools: { listChanged: false } },
        instructions: 'Whale offers read-only platform access and local Agent task handoff. No platform writes are exposed.',
        ttlMs: 0,
        cacheScope: 'private',
      })
      if (message.method === 'tools/list') return response({
        tools: await registry.listTools(), ttlMs: 0, cacheScope: 'private',
      })
      if (message.method === 'tools/call') {
        if (typeof params.name !== 'string' || !params.name) {
          return rpcError(id, -32602, 'tools/call requires params.name')
        }
        const toolResult = await registry.callTool(params.name, params.arguments ?? {})
        return response(toolResult)
      }
      return rpcError(id, -32601, 'Method not found')
    } catch (error) {
      return rpcError(id, -32603, 'Internal error', { message: String(error?.message ?? error).slice(0, 500) })
    }
  }

  return { handleMessage }
}

export async function runStdioMcpServer({ registry, serverInfo, input = process.stdin, output = process.stdout } = {}) {
  const handler = createMcpProtocolHandler({ registry, serverInfo })
  const modernHandler = createModernMcpProtocolHandler({ registry, serverInfo })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let message = null
    try { message = JSON.parse(line) } catch {}
    const meta = message?.params?._meta
    const hasModernEnvelope = Boolean(meta && typeof meta === 'object' && !Array.isArray(meta)
      && [MODERN_META_VERSION, MODERN_CLIENT_INFO, MODERN_CLIENT_CAPABILITIES]
        .some(key => Object.prototype.hasOwnProperty.call(meta, key)))
    const response = hasModernEnvelope || message?.method === 'server/discover'
      ? await modernHandler.handleMessage(message)
      : await handler.handleMessage(line)
    if (response) output.write(JSON.stringify(response) + '\n')
  }
}
