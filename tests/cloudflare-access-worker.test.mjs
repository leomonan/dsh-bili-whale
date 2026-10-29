import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createCloudflareMcpGateway } from '../workers/whale-mcp-gateway.js'

const ISSUER = 'https://whale-test.cloudflareaccess.com'
const AUDIENCE = 'test-access-audience'
const ORIGIN_TOKEN = 'internal-origin-token-0123456789abcdef'
const ENV = {
  CF_ACCESS_TEAM_DOMAIN: ISSUER,
  CF_ACCESS_AUD: AUDIENCE,
  WHALE_MCP_ORIGIN_URL: 'https://origin.example.com/mcp',
  WHALE_MCP_ORIGIN_TOKEN: ORIGIN_TOKEN,
  CF_ACCESS_ORIGIN_CLIENT_ID: 'origin-service-token-id',
  CF_ACCESS_ORIGIN_CLIENT_SECRET: 'origin-service-token-secret-0123456789',
  WHALE_ALLOWED_ORIGINS: 'https://agent.example.com',
}
const encoder = new TextEncoder()
const b64url = bytes => Buffer.from(bytes).toString('base64url')
const encodeJson = value => b64url(encoder.encode(JSON.stringify(value)))

async function makeSigner() {
  const pair = await webcrypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify'])
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  publicJwk.kid = 'access-key-1'
  publicJwk.use = 'sig'
  publicJwk.alg = 'RS256'
  async function sign(claimOverrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT', kid: 'access-key-1', ...headerOverrides }
    const claims = {
      iss: ISSUER,
      aud: [AUDIENCE],
      sub: 'access-user-123',
      iat: now,
      nbf: now - 1,
      exp: now + 300,
      ...claimOverrides,
    }
    const input = encodeJson(header) + '.' + encodeJson(claims)
    const signature = await webcrypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, encoder.encode(input))
    return input + '.' + b64url(signature)
  }
  return { publicJwk, sign }
}

function request(token, options = {}) {
  const method = options.method || 'POST'
  const headers = new Headers(options.headers || {})
  if (token) headers.set('Cf-Access-Jwt-Assertion', token)
  if (method === 'POST' && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Request('https://whale.example.com/mcp', {
    method,
    headers,
    ...(method === 'POST' ? { body: options.body ?? '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' } : {}),
  })
}

function gatewayWithSigner(signer, extras = {}) {
  let upstreamCall = null
  let jwksCalls = 0
  const gateway = createCloudflareMcpGateway({
    fetchImpl: async (input, init) => {
      if (String(input instanceof Request ? input.url : input).endsWith('/cdn-cgi/access/certs')) {
        jwksCalls += 1
        return Response.json({ keys: [signer.publicJwk] })
      }
      const req = input instanceof Request ? input : new Request(input, init)
      upstreamCall = req
      return Response.json({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } })
    },
  })
  return { gateway, get upstreamCall() { return upstreamCall }, get jwksCalls() { return jwksCalls }, env: { ...ENV, ...extras } }
}

test('valid Access assertion proxies to one fixed HTTPS origin using only the origin token', async () => {
  const signer = await makeSigner()
  const fixture = gatewayWithSigner(signer)
  const token = await signer.sign()
  const response = await fixture.gateway.fetch(request(token, {
    headers: {
      origin: 'https://agent.example.com',
      authorization: 'Bearer opaque-oauth-token',
      cookie: 'session=secret',
      'x-forwarded-host': 'attacker.example',
      'x-internal-admin': 'yes',
      'cf-access-client-id': 'attacker-supplied-id',
      'cf-access-client-secret': 'attacker-supplied-secret',
    },
  }), fixture.env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://agent.example.com')
  assert.equal(fixture.upstreamCall.url, 'https://origin.example.com/mcp')
  assert.equal(fixture.upstreamCall.headers.get('authorization'), 'Bearer ' + ORIGIN_TOKEN)
  assert.equal(fixture.upstreamCall.headers.get('cf-access-client-id'), ENV.CF_ACCESS_ORIGIN_CLIENT_ID)
  assert.equal(fixture.upstreamCall.headers.get('cf-access-client-secret'), ENV.CF_ACCESS_ORIGIN_CLIENT_SECRET)
  assert.notEqual(fixture.upstreamCall.headers.get('cf-access-client-id'), 'attacker-supplied-id')
  assert.notEqual(fixture.upstreamCall.headers.get('cf-access-client-secret'), 'attacker-supplied-secret')
  assert.equal(fixture.upstreamCall.headers.get('cf-access-jwt-assertion'), null)
  assert.equal(fixture.upstreamCall.headers.get('cookie'), null)
  assert.equal(fixture.upstreamCall.headers.get('origin'), null)
  assert.equal(fixture.upstreamCall.headers.get('x-forwarded-host'), null)
  assert.equal(fixture.upstreamCall.headers.get('x-internal-admin'), null)
  assert.equal(fixture.jwksCalls, 1)
})

test('missing, tampered, expired, wrong-issuer, wrong-audience and non-RS256 assertions fail closed', async () => {
  const signer = await makeSigner()
  const fixture = gatewayWithSigner(signer)
  const good = await signer.sign()
  const parts = good.split('.')
  const tampered = parts[0] + '.' + encodeJson({ iss: ISSUER, aud: [AUDIENCE], exp: Math.floor(Date.now() / 1000) + 300 }) + '.' + parts[2]
  const cases = [
    [null, {}, 401],
    [tampered, {}, 401],
    [await signer.sign({ exp: Math.floor(Date.now() / 1000) - 1 }), {}, 401],
    [await signer.sign({ iss: 'https://attacker.cloudflareaccess.com' }), {}, 401],
    [await signer.sign({ aud: ['other-audience'] }), {}, 401],
    [await signer.sign({}, { alg: 'none' }), {}, 401],
  ]
  for (const [token, extra, expectedStatus] of cases) {
    const response = await fixture.gateway.fetch(request(token, extra), fixture.env)
    assert.equal(response.status, expectedStatus)
  }
  assert.equal(fixture.upstreamCall, null)
})

test('unknown signing key refreshes JWKS once and remains fail-closed if still unknown', async () => {
  const signer = await makeSigner()
  let calls = 0
  const gateway = createCloudflareMcpGateway({
    fetchImpl: async url => {
      calls += 1
      return Response.json({ keys: calls === 1 ? [{ ...signer.publicJwk, kid: 'old-key' }] : [{ ...signer.publicJwk, kid: 'old-key' }] })
    },
  })
  const token = await signer.sign()
  const response = await gateway.fetch(request(token), ENV)
  assert.equal(response.status, 401)
  assert.equal(calls, 2)
})

test('JWKS outage returns 503 and does not call the origin', async () => {
  const signer = await makeSigner()
  let fetchCalls = 0
  const gateway = createCloudflareMcpGateway({
    fetchImpl: async () => {
      fetchCalls += 1
      return Response.json({ error: 'unavailable' }, { status: 503 })
    },
  })
  const token = await signer.sign()
  const response = await gateway.fetch(request(token), ENV)
  assert.equal(response.status, 503)
  assert.equal(fetchCalls, 1, 'only the JWKS endpoint should be requested')
})

test('origin allowlist, path, method, body size and upstream URL are fail-closed', async () => {
  const signer = await makeSigner()
  const fixture = gatewayWithSigner(signer)
  const token = await signer.sign()
  assert.equal((await fixture.gateway.fetch(request(token, { headers: { origin: 'https://evil.example' } }), fixture.env)).status, 403)
  const wrongPath = new Request('https://whale.example.com/admin', { method: 'POST', body: '{}' })
  assert.equal((await fixture.gateway.fetch(wrongPath, fixture.env)).status, 404)
  const get = new Request('https://whale.example.com/mcp', { method: 'GET' })
  assert.equal((await fixture.gateway.fetch(get, fixture.env)).status, 405)
  const huge = request(token, { body: 'x'.repeat(1_000_001) })
  assert.equal((await fixture.gateway.fetch(huge, fixture.env)).status, 413)
  assert.equal((await fixture.gateway.fetch(request(token), { ...fixture.env, WHALE_MCP_ORIGIN_URL: 'http://origin.example.com/mcp' })).status, 503)
  assert.equal((await fixture.gateway.fetch(request(token), { ...fixture.env, WHALE_MCP_ORIGIN_URL: 'https://127.0.0.1/mcp' })).status, 503)
  assert.equal(fixture.upstreamCall, null)
})

test('preflight uses exact CORS allowlist and never calls the origin', async () => {
  let calls = 0
  const gateway = createCloudflareMcpGateway({ fetchImpl: async () => { calls += 1; return Response.json({}) } })
  const ok = await gateway.fetch(new Request('https://whale.example.com/mcp', {
    method: 'OPTIONS',
    headers: { origin: 'https://agent.example.com' },
  }), ENV)
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://agent.example.com')
  const denied = await gateway.fetch(new Request('https://whale.example.com/mcp', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
  }), ENV)
  assert.equal(denied.status, 403)
  assert.equal(calls, 0)
})


test('origin service-token credentials are mandatory before proxying', async () => {
  const signer = await makeSigner()
  const fixture = gatewayWithSigner(signer)
  const token = await signer.sign()
  for (const env of [
    { ...fixture.env, CF_ACCESS_ORIGIN_CLIENT_ID: '' },
    { ...fixture.env, CF_ACCESS_ORIGIN_CLIENT_SECRET: '' },
  ]) {
    const response = await fixture.gateway.fetch(request(token), env)
    assert.equal(response.status, 503)
  }
  assert.equal(fixture.upstreamCall, null)
})


test('opaque OAuth bearer token alone is never accepted as the Access origin assertion', async () => {
  const signer = await makeSigner()
  let jwksCalls = 0
  let originCalls = 0
  const gateway = createCloudflareMcpGateway({
    fetchImpl: async input => {
      if (String(input instanceof Request ? input.url : input).endsWith('/cdn-cgi/access/certs')) {
        jwksCalls += 1
        return Response.json({ keys: [signer.publicJwk] })
      }
      originCalls += 1
      return Response.json({ ok: true })
    },
  })
  const req = new Request('https://whale.example.com/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer oauth:opaque-token-from-managed-oauth', 'content-type': 'application/json' },
    body: '{}',
  })
  const response = await gateway.fetch(req, ENV)
  assert.equal(response.status, 401)
  assert.equal(jwksCalls, 0)
  assert.equal(originCalls, 0)
})


test('Cloudflare Access issuer must use the configured Cloudflare team domain', async () => {
  const signer = await makeSigner()
  let fetchCalls = 0
  const gateway = createCloudflareMcpGateway({ fetchImpl: async () => { fetchCalls += 1; return Response.json({ keys: [signer.publicJwk] }) } })
  const response = await gateway.fetch(request(await signer.sign()), { ...ENV, CF_ACCESS_TEAM_DOMAIN: 'https://attacker.example.com' })
  assert.equal(response.status, 503)
  assert.equal(fetchCalls, 0)
})
