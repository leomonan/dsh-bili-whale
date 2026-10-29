import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCloudflareAccessSmoke } from '../scripts/cloudflare-access-smoke.mjs'

const metadata = {
  issuer: 'https://team.cloudflareaccess.com',
  authorization_endpoint: 'https://team.cloudflareaccess.com/authorize',
  token_endpoint: 'https://team.cloudflareaccess.com/token',
}
const resourceMetadata = {
  resource: 'https://mcp-test.example.com',
  protected: true,
  team_domain: 'team.cloudflareaccess.com',
  authorization_servers: ['https://team.cloudflareaccess.com'],
}

test('Cloudflare smoke validates OAuth metadata and protected endpoint challenge without credentials', async () => {
  const calls = []
  const result = await runCloudflareAccessSmoke({
    baseUrl: 'https://mcp-test.example.com',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).endsWith('/.well-known/oauth-authorization-server')) return Response.json(metadata)
      if (String(input).endsWith('/.well-known/cloudflare-access-protected-resource/')) return Response.json(resourceMetadata)
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp-test.example.com/.well-known/cloudflare-access-protected-resource/"' },
      })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.noCredentialsSent, true)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[2].init.method, 'GET')
  assert.equal(result.resourceMetadataUrl, 'https://mcp-test.example.com/.well-known/cloudflare-access-protected-resource/')
  assert.equal(calls[1].init.headers.authorization, undefined)
  assert.equal(calls[1].init.headers.Authorization, undefined)
  assert.equal(result.authorizationEndpoint, metadata.authorization_endpoint)
})

test('Cloudflare smoke fails closed when metadata or Access challenge is invalid', async () => {
  await assert.rejects(runCloudflareAccessSmoke({
    baseUrl: 'https://mcp-test.example.com',
    fetchImpl: async () => Response.json({ issuer: metadata.issuer, authorization_endpoint: 'http://bad.example/authorize', token_endpoint: metadata.token_endpoint }),
  }), /must contain HTTPS/)

  let count = 0
  await assert.rejects(runCloudflareAccessSmoke({
    baseUrl: 'https://mcp-test.example.com',
    fetchImpl: async () => {
      count += 1
      return count === 1
        ? Response.json(metadata)
        : new Response('redirect', { status: 302, headers: { location: 'https://login.example.com' } })
    },
  }), /must return HTTP 401 with WWW-Authenticate/)
})

test('Cloudflare smoke requires HTTPS and does not run without explicit opt-in', () => {
  const script = fileURLToPath(new URL('../scripts/cloudflare-access-smoke.mjs', import.meta.url))
  const badUrl = spawnSync(process.execPath, [script], {
    env: { ...process.env, WHALE_RUN_CLOUDFLARE_SMOKE: '1', WHALE_CLOUDFLARE_TEST_URL: 'http://mcp-test.example.com' },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(badUrl.status, 1)
  assert.match(badUrl.stderr, /HTTPS origin/)
  const noOptIn = spawnSync(process.execPath, [script], {
    env: { ...process.env, WHALE_RUN_CLOUDFLARE_SMOKE: '', WHALE_CLOUDFLARE_TEST_URL: 'https://mcp-test.example.com' },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(noOptIn.status, 2)
  assert.match(noOptIn.stderr, /opt-in/)
})


test('Cloudflare smoke rejects off-origin protected-resource metadata and issuer mismatch', async () => {
  let calls = 0
  await assert.rejects(runCloudflareAccessSmoke({
    baseUrl: 'https://mcp-test.example.com',
    fetchImpl: async input => {
      calls += 1
      if (String(input).endsWith('/.well-known/oauth-authorization-server')) return Response.json(metadata)
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://attacker.example/metadata"' },
      })
    },
  }), /same HTTPS origin/)
  assert.equal(calls, 2, 'must not fetch an off-origin resource_metadata URL')

  calls = 0
  await assert.rejects(runCloudflareAccessSmoke({
    baseUrl: 'https://mcp-test.example.com',
    fetchImpl: async input => {
      calls += 1
      if (String(input).endsWith('/.well-known/oauth-authorization-server')) return Response.json(metadata)
      if (String(input).endsWith('/.well-known/cloudflare-access-protected-resource/')) {
        return Response.json({ ...resourceMetadata, authorization_servers: ['https://other.cloudflareaccess.com'] })
      }
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp-test.example.com/.well-known/cloudflare-access-protected-resource/"' },
      })
    },
  }), /does not match/)
})
