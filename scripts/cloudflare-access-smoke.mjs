#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function httpsOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('WHALE_CLOUDFLARE_TEST_URL must be a valid HTTPS origin') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WHALE_CLOUDFLARE_TEST_URL must be an HTTPS origin without credentials, path, query, or fragment')
  }
  return url.origin
}

function validHttpsEndpoint(value) {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

export async function runCloudflareAccessSmoke({ baseUrl, fetchImpl = fetch } = {}) {
  const origin = httpsOrigin(baseUrl)
  let metadataResponse
  try {
    metadataResponse = await fetchImpl(new URL('/.well-known/oauth-authorization-server', origin), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Cloudflare OAuth authorization-server metadata endpoint is unreachable')
  }
  if (!metadataResponse.ok) throw new Error('OAuth metadata endpoint returned HTTP ' + metadataResponse.status)
  let metadata
  try { metadata = await metadataResponse.json() } catch { throw new Error('OAuth metadata endpoint returned invalid JSON') }
  if (!metadata || !validHttpsEndpoint(metadata.authorization_endpoint) || !validHttpsEndpoint(metadata.token_endpoint)) {
    throw new Error('OAuth metadata must contain HTTPS authorization_endpoint and token_endpoint')
  }
  if (metadata.issuer !== undefined && !validHttpsEndpoint(metadata.issuer)) throw new Error('OAuth metadata issuer must be HTTPS')

  let protectedResponse
  try {
    protectedResponse = await fetchImpl(new URL('/mcp', origin), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cloudflare-access-smoke',
        method: 'server/discover',
        params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        } },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Protected MCP endpoint is unreachable')
  }
  const challenge = protectedResponse.headers.get('www-authenticate') || ''
  if (protectedResponse.status !== 401 || !challenge) {
    throw new Error('Unauthenticated MCP probe must return HTTP 401 with WWW-Authenticate; got HTTP ' + protectedResponse.status)
  }
  return {
    ok: true,
    origin,
    issuer: typeof metadata.issuer === 'string' ? metadata.issuer : null,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    protectedMcpChallenge: challenge.slice(0, 300),
    noCredentialsSent: true,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.env.WHALE_RUN_CLOUDFLARE_SMOKE !== '1') {
    process.stderr.write('[whale-agent] Cloudflare smoke test is opt-in; set WHALE_RUN_CLOUDFLARE_SMOKE=1 and WHALE_CLOUDFLARE_TEST_URL to run read-only probes.\n')
    process.exitCode = 2
  } else {
    try {
      const result = await runCloudflareAccessSmoke({ baseUrl: process.env.WHALE_CLOUDFLARE_TEST_URL })
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } catch (error) {
      process.stderr.write('[whale-agent] Cloudflare smoke failed: ' + String(error?.message ?? error).slice(0, 500) + '\n')
      process.exitCode = 1
    }
  }
}
