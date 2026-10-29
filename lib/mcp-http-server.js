import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createMcpProtocolHandler, createModernMcpProtocolHandler, MODERN_MCP_VERSION } from './mcp-server.js'

const SESSION_HEADER = 'mcp-session-id'
const VERSION_HEADER = 'mcp-protocol-version'
const MAX_SESSIONS = 1_000

function equalSecret(actual, expected) {
  const a = Buffer.from(String(actual ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

const MODERN_META_VERSION = 'io.modelcontextprotocol/protocolVersion'

function headerValue(value) {
  if (typeof value !== 'string') return null
  const match = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value)
  if (!match) return value
  const bytes = Buffer.from(match[1], 'base64')
  // Buffer's decoder is permissive. Reject non-canonical Base64 and invalid UTF-8
  // rather than allowing a malformed sentinel to compare as a different string.
  if (bytes.toString('base64') !== match[1]) return null
  const decoded = bytes.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null
  return decoded
}

function modernHeaderError(message, headers) {
  const version = message?.params?._meta?.[MODERN_META_VERSION]
  if (headers[VERSION_HEADER] !== version || typeof version !== 'string' || !version) {
    return 'Mcp-Protocol-Version does not match request _meta'
  }
  if (headers['mcp-method'] !== message?.method) return 'Mcp-Method does not match request method'
  if (message.method === 'tools/call') {
    if (!message.params || typeof message.params.name !== 'string' || headerValue(headers['mcp-name']) !== message.params.name) {
      return 'Mcp-Name does not match tools/call name'
    }
  }
  return null
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

async function readBody(req, maxBytes) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) oversized = true
    else if (!oversized) chunks.push(chunk)
  }
  if (oversized) {
    const error = new Error('Request body exceeds size limit')
    error.statusCode = 413
    throw error
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createMcpHttpServer({
  registry,
  serverInfo = { name: 'whale-agent', version: '0.1.0' },
  authToken,
  host = '127.0.0.1',
  port = 8765,
  allowedOrigins = [],
  maxBodyBytes = 1_000_000,
  sessionTtlMs = 30 * 60_000,
  maxSessions = MAX_SESSIONS,
  now = Date.now,
} = {}) {
  if (!registry || typeof registry.listTools !== 'function' || typeof registry.callTool !== 'function') {
    throw new TypeError('registry must implement listTools() and callTool()')
  }
  if (typeof authToken !== 'string' || authToken.length < 32) {
    throw new Error('WHALE_MCP_AUTH_TOKEN must contain at least 32 characters')
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 5_000_000) {
    throw new TypeError('maxBodyBytes must be from 1024 to 5000000')
  }
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > 24 * 60 * 60_000) {
    throw new TypeError('sessionTtlMs must be from 1000 to 86400000')
  }
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS) {
    throw new TypeError('maxSessions must be from 1 to ' + MAX_SESSIONS)
  }
  const origins = new Set(allowedOrigins)
  const sessions = new Map()
  const modernHandler = createModernMcpProtocolHandler({ registry, serverInfo })

  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    const origin = req.headers.origin
    if (origin) {
      if (!origins.has(origin)) {
        sendJson(res, 403, { error: 'Origin not allowed' })
        return
      }
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name')
      res.setHeader('access-control-allow-methods', 'POST, DELETE, OPTIONS')
      res.setHeader('access-control-expose-headers', 'Mcp-Session-Id, Mcp-Protocol-Version')
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const authorization = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    if (!match || !equalSecret(match[1], authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' })
      return
    }

    const currentTime = now()
    for (const [id, session] of sessions) {
      if ((session.activeRequests ?? 0) === 0 && currentTime - session.lastUsedAt > sessionTtlMs) sessions.delete(id)
    }

    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE, OPTIONS' })
      res.end()
      return
    }

    if (req.method === 'DELETE') {
      if (req.headers[VERSION_HEADER] === MODERN_MCP_VERSION) {
        res.writeHead(405, { allow: 'POST, OPTIONS' })
        res.end()
        return
      }
      const id = String(req.headers[SESSION_HEADER] ?? '')
      if (!id || !sessions.has(id)) {
        sendJson(res, 404, { error: 'MCP session not found' })
        return
      }
      if ((sessions.get(id).activeRequests ?? 0) > 0) {
        sendJson(res, 409, { error: 'MCP session has an active request' })
        return
      }
      sessions.delete(id)
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE, OPTIONS' })
      res.end()
      return
    }

    if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      sendJson(res, 415, { error: 'Content-Type must be application/json' })
      return
    }

    let raw
    let message
    try {
      raw = await readBody(req, maxBodyBytes)
      message = JSON.parse(raw)
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, { error: error.statusCode === 413 ? error.message : 'Invalid JSON request' })
      return
    }

    const method = message?.method
    const modernVersion = message?.params?._meta?.[MODERN_META_VERSION]
    if (modernVersion !== undefined || req.headers[VERSION_HEADER] === MODERN_MCP_VERSION || req.headers['mcp-method'] !== undefined || method === 'server/discover') {
      const mismatch = modernHeaderError(message, req.headers)
      if (mismatch) {
        sendJson(res, 400, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32020, message: 'HeaderMismatch: ' + mismatch } })
        return
      }
      const response = await modernHandler.handleMessage(message)
      if (!response) {
        res.writeHead(202)
        res.end()
      } else {
        sendJson(res, response.error?.code === -32601 ? 404 : response.error?.code === -32022 ? 400 : response.error ? 400 : 200, response)
      }
      return
    }
    const sessionId = String(req.headers[SESSION_HEADER] ?? '')
    let session
    let createdSessionId = null
    if (method === 'initialize') {
      if (sessions.size >= maxSessions) {
        sendJson(res, 503, { error: 'MCP session capacity reached; retry later' })
        return
      }
      if (sessionId) {
        sendJson(res, 400, { error: 'Initialize must not include an MCP session ID' })
        return
      }
      session = { handler: createMcpProtocolHandler({ registry, serverInfo }), lastUsedAt: currentTime, protocolVersion: null, activeRequests: 0 }
      const response = await session.handler.handleMessage(raw)
      if (!response || response.error) {
        sendJson(res, 400, response ?? { error: 'Invalid initialize request' })
        return
      }
      createdSessionId = randomUUID()
      session.protocolVersion = response.result.protocolVersion
      session.lastUsedAt = now()
      sessions.set(createdSessionId, session)
      sendJson(res, 200, response, {
        [SESSION_HEADER]: createdSessionId,
        [VERSION_HEADER]: session.protocolVersion,
      })
      return
    }

    session = sessions.get(sessionId)
    if (!session) {
      sendJson(res, 404, { error: 'MCP session not found or expired' })
      return
    }
    const requestedVersion = req.headers[VERSION_HEADER]
    if (requestedVersion && requestedVersion !== session.protocolVersion) {
      sendJson(res, 400, { error: 'MCP protocol version does not match the initialized session' })
      return
    }
    session.activeRequests = (session.activeRequests ?? 0) + 1
    try {
      const response = await session.handler.handleMessage(raw)
      if (!response) {
        res.writeHead(202, { [SESSION_HEADER]: sessionId, [VERSION_HEADER]: session.protocolVersion })
        res.end()
        return
      }
      sendJson(res, 200, response, {
        [SESSION_HEADER]: sessionId,
        [VERSION_HEADER]: session.protocolVersion,
      })
    } finally {
      session.activeRequests = Math.max(0, (session.activeRequests ?? 1) - 1)
      session.lastUsedAt = now()
    }
  })

  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000

  return {
    server,
    get sessionCount() { return sessions.size },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        for (const id of sessions.keys()) sessions.delete(id)
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}
