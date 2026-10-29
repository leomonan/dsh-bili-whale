const JWKS_TTL_MS = 5 * 60 * 1000
const MAX_REQUEST_BYTES = 1_000_000
const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion'

class AuthFailure extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  })
}

function base64UrlBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AuthFailure(401, 'Invalid Access assertion encoding')
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  let binary
  try { binary = atob(padded) } catch { throw new AuthFailure(401, 'Invalid Access assertion encoding') }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function decodeJsonSegment(value) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlBytes(value))) } catch (error) {
    if (error instanceof AuthFailure) throw error
    throw new AuthFailure(401, 'Invalid Access assertion JSON')
  }
}

function normalizeIssuer(value) {
  if (typeof value !== 'string' || !value.trim()) throw new AuthFailure(503, 'CF_ACCESS_TEAM_DOMAIN is required')
  let url
  try { url = new URL(value.includes('://') ? value : 'https://' + value) } catch {
    throw new AuthFailure(503, 'CF_ACCESS_TEAM_DOMAIN is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new AuthFailure(503, 'CF_ACCESS_TEAM_DOMAIN must be an HTTPS origin without path, credentials, port, query, or fragment')
  }
  return url.origin
}

function validAudience(claim, expected) {
  return typeof claim === 'string' ? claim === expected : Array.isArray(claim) && claim.includes(expected)
}

async function getJwks(issuer, fetchImpl, cache, now, forceRefresh = false) {
  const url = issuer + '/cdn-cgi/access/certs'
  const cached = cache.get(url)
  if (!forceRefresh && cached && now() - cached.at < JWKS_TTL_MS) return cached.keys
  let response
  try { response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error' }) } catch {
    throw new AuthFailure(503, 'Unable to reach Cloudflare Access signing keys')
  }
  if (!response.ok) throw new AuthFailure(503, 'Cloudflare Access signing keys returned HTTP ' + response.status)
  let body
  try { body = await response.json() } catch { throw new AuthFailure(503, 'Cloudflare Access signing keys returned invalid JSON') }
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) throw new AuthFailure(503, 'Cloudflare Access signing key set is invalid')
  cache.set(url, { at: now(), keys: body.keys })
  return body.keys
}

async function verifyAssertion(token, env, fetchImpl, cache, now) {
  const issuer = normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN)
  const audience = typeof env.CF_ACCESS_AUD === 'string' ? env.CF_ACCESS_AUD.trim() : ''
  if (!audience) throw new AuthFailure(503, 'CF_ACCESS_AUD is required')
  if (typeof token !== 'string' || token.length < 32 || token.length > 16_384) throw new AuthFailure(401, 'Missing or invalid Cloudflare Access assertion')
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthFailure(401, 'Invalid Cloudflare Access assertion')
  const header = decodeJsonSegment(parts[0])
  const claims = decodeJsonSegment(parts[1])
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new AuthFailure(401, 'Unsupported Cloudflare Access assertion signing algorithm')
  if (!claims || claims.iss !== issuer || !validAudience(claims.aud, audience)) throw new AuthFailure(401, 'Cloudflare Access assertion issuer or audience mismatch')
  const nowSeconds = Math.floor(now() / 1000)
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds))
      || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60))) {
    throw new AuthFailure(401, 'Cloudflare Access assertion is expired or not yet valid')
  }
  let keys = await getJwks(issuer, fetchImpl, cache, now)
  const findKey = list => list.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'))
  let jwk = findKey(keys)
  if (!jwk) {
    keys = await getJwks(issuer, fetchImpl, cache, now, true)
    jwk = findKey(keys)
  }
  if (!jwk) throw new AuthFailure(401, 'Cloudflare Access assertion signing key was not found')
  let publicKey
  try { publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) } catch {
    throw new AuthFailure(503, 'Cloudflare Access signing key could not be imported')
  }
  let valid = false
  try {
    valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, base64UrlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))
  } catch {}
  if (!valid) throw new AuthFailure(401, 'Cloudflare Access assertion signature is invalid')
  return claims
}

function originUrlFromEnv(env) {
  if (typeof env.WHALE_MCP_ORIGIN_URL !== 'string' || !env.WHALE_MCP_ORIGIN_URL.trim()) throw new AuthFailure(503, 'WHALE_MCP_ORIGIN_URL is required')
  let url
  try { url = new URL(env.WHALE_MCP_ORIGIN_URL) } catch { throw new AuthFailure(503, 'WHALE_MCP_ORIGIN_URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('/mcp')) {
    throw new AuthFailure(503, 'WHALE_MCP_ORIGIN_URL must be HTTPS, contain no credentials/query/fragment, and end in /mcp')
  }
  if (typeof env.WHALE_MCP_ORIGIN_TOKEN !== 'string' || env.WHALE_MCP_ORIGIN_TOKEN.length < 32) {
    throw new AuthFailure(503, 'WHALE_MCP_ORIGIN_TOKEN must be a configured secret of at least 32 characters')
  }
  return url
}

function originAllowlist(env) {
  return String(env.WHALE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin')
  if (!origin) return {}
  if (!originAllowlist(env).includes(origin)) throw new AuthFailure(403, 'Origin not allowed')
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

async function readBoundedBody(request) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_REQUEST_BYTES) throw new AuthFailure(413, 'Request body exceeds size limit')
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new AuthFailure(413, 'Request body exceeds size limit')
  return bytes
}

async function handleRequest(request, env, fetchImpl, now, cache) {
  const url = new URL(request.url)
  if (url.pathname !== '/mcp') return json({ error: 'Not found' }, 404)
  if (!['POST', 'DELETE', 'OPTIONS'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { allow: 'POST, DELETE, OPTIONS' })
  let cors
  try { cors = corsHeaders(request, env) } catch (error) {
    if (error instanceof AuthFailure) return json({ error: error.message }, error.status)
    return json({ error: 'Request rejected' }, 400)
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

  try {
    await verifyAssertion(request.headers.get(ACCESS_ASSERTION_HEADER), env, fetchImpl, cache, now)
    const originUrl = originUrlFromEnv(env)
    const body = request.method === 'POST' ? await readBoundedBody(request) : undefined
    const headers = new Headers()
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase()
      if (lower === 'authorization' || lower === 'cookie' || lower.startsWith('cf-access-')
          || lower === 'host' || lower === 'content-length' || lower === 'origin' || lower === 'connection') continue
      headers.set(name, value)
    }
    headers.set('authorization', 'Bearer ' + env.WHALE_MCP_ORIGIN_TOKEN)
    if (request.method === 'POST' && !headers.has('content-type')) throw new AuthFailure(415, 'Content-Type is required for MCP POST requests')
    const upstreamRequest = new Request(originUrl, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
    })
    const upstreamResponse = await fetchImpl(upstreamRequest)
    const responseHeaders = new Headers(upstreamResponse.headers)
    for (const key of ['set-cookie', 'www-authenticate', 'location', 'server', 'cf-ray']) responseHeaders.delete(key)
    for (const [name, value] of Object.entries(cors)) responseHeaders.set(name, value)
    responseHeaders.set('cache-control', 'no-store')
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders })
  } catch (error) {
    if (error instanceof AuthFailure) return json({ error: error.message }, error.status, cors)
    return json({ error: 'MCP upstream request failed' }, 502, cors)
  }
}

export function createCloudflareMcpGateway({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  return { fetch: (request, env) => handleRequest(request, env, fetchImpl, now, cache) }
}

const defaultGateway = createCloudflareMcpGateway()
export default { fetch(request, env) { return defaultGateway.fetch(request, env) } }
