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
  if (!metadata || !validHttpsEndpoint(metadata.issuer) || !validHttpsEndpoint(metadata.authorization_endpoint) || !validHttpsEndpoint(metadata.token_endpoint)) {
    throw new Error('OAuth metadata must contain HTTPS issuer, authorization_endpoint, and token_endpoint')
  }
  const issuerOrigin = new URL(metadata.issuer).origin
  if (new URL(metadata.authorization_endpoint).origin !== issuerOrigin || new URL(metadata.token_endpoint).origin !== issuerOrigin) {
    throw new Error('Cloudflare OAuth authorization and token endpoints must share the issuer origin')
  }

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
  const resourceMatch = /resource_metadata="([^"]+)"/i.exec(challenge)
  if (!resourceMatch) throw new Error('Access challenge must include a resource_metadata URL')
  let resourceMetadataUrl
  try { resourceMetadataUrl = new URL(resourceMatch[1]) } catch { throw new Error('Access resource_metadata URL is invalid') }
  if (resourceMetadataUrl.protocol !== 'https:' || resourceMetadataUrl.origin !== origin || resourceMetadataUrl.username || resourceMetadataUrl.password || resourceMetadataUrl.hash) {
    throw new Error('Access resource_metadata must use the same HTTPS origin as the MCP endpoint')
  }
  let resourceResponse
  try {
    resourceResponse = await fetchImpl(resourceMetadataUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('OAuth protected-resource metadata endpoint is unreachable')
  }
  if (!resourceResponse.ok) throw new Error('Protected-resource metadata endpoint returned HTTP ' + resourceResponse.status)
  let resourceMetadata
  try { resourceMetadata = await resourceResponse.json() } catch { throw new Error('Protected-resource metadata endpoint returned invalid JSON') }
  if (!resourceMetadata || typeof resourceMetadata.resource !== 'string'
      || new URL(resourceMetadata.resource).origin !== origin
      || !Array.isArray(resourceMetadata.authorization_servers)
      || resourceMetadata.authorization_servers.length === 0
      || !resourceMetadata.authorization_servers.every(validHttpsEndpoint)) {
    throw new Error('Protected-resource metadata must identify this resource and HTTPS authorization_servers')
  }
  const issuerUrl = new URL(metadata.issuer)
  const authorizationServers = resourceMetadata.authorization_servers.map(value => new URL(value))
  if (!authorizationServers.some(value => value.origin === issuerUrl.origin)) {
    throw new Error('OAuth issuer does not match any protected-resource authorization_server')
  }
  return {
    ok: true,
    origin,
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    resourceMetadataUrl: resourceMetadataUrl.href,
    authorizationServers: resourceMetadata.authorization_servers,
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
