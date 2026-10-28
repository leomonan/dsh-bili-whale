import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatibleModelClient, validateModelBaseUrl } from '../lib/model-client.js'

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload) },
  }
}

test('model client sends fixed model, tools, and bearer auth to OpenAI-compatible endpoint', async () => {
  let captured
  const client = createOpenAICompatibleModelClient({
    apiKey: 'test-secret',
    baseUrl: 'https://model.example.com/v1',
    model: 'fixed-model-v1',
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init }
      return response({ model: 'fixed-model-v1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }], usage: { total_tokens: 12 } })
    },
  })
  const result = await client.complete({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'whale_status', parameters: { type: 'object' } } }],
  })
  assert.equal(captured.url, 'https://model.example.com/v1/chat/completions')
  assert.equal(captured.init.headers.authorization, 'Bearer test-secret')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.model, 'fixed-model-v1')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools[0].function.name, 'whale_status')
  assert.equal(result.message.content, 'Hello')
  assert.equal(result.usage.total_tokens, 12)
})

test('model client accepts tool calls and works without tools when not supplied', async () => {
  const client = createOpenAICompatibleModelClient({
    apiKey: 'secret',
    baseUrl: 'https://model.example.com/v1/',
    model: 'test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(Object.hasOwn(body, 'tools'), false)
      return response({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'whale_get_feed', arguments: '{"limit":2}' } }] } }] })
    },
  })
  const result = await client.complete({ messages: [{ role: 'user', content: 'look' }] })
  assert.equal(result.message.tool_calls[0].id, 'call-1')
})

test('model client reports HTTP, malformed JSON, and malformed response failures', async () => {
  const base = { apiKey: 'secret', baseUrl: 'https://model.example.com/v1', model: 'test' }
  const failed = createOpenAICompatibleModelClient({ ...base, fetchImpl: async () => response('quota exceeded', 429) })
  await assert.rejects(failed.complete({ messages: [{ role: 'user', content: 'hi' }] }), /HTTP 429.*quota exceeded/)
  const invalidJson = createOpenAICompatibleModelClient({ ...base, fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error('bad json') } }) })
  await assert.rejects(invalidJson.complete({ messages: [{ role: 'user', content: 'hi' }] }), /invalid JSON/)
  const malformed = createOpenAICompatibleModelClient({ ...base, fetchImpl: async () => response({ choices: [] }) })
  await assert.rejects(malformed.complete({ messages: [{ role: 'user', content: 'hi' }] }), /no assistant message/)
})

test('model client requires explicit API key and fixed model', () => {
  assert.throws(() => createOpenAICompatibleModelClient({ apiKey: '', model: 'm' }), /WHALE_MODEL_API_KEY/)
  assert.throws(() => createOpenAICompatibleModelClient({ apiKey: 'key', model: '' }), /WHALE_MODEL/)
})

test('model endpoint requires HTTPS except loopback or explicit HTTP opt-in', () => {
  assert.equal(validateModelBaseUrl('https://api.example.com/v1').href, 'https://api.example.com/v1/')
  assert.equal(validateModelBaseUrl('http://127.0.0.1:11434/v1').href, 'http://127.0.0.1:11434/v1/')
  assert.throws(() => validateModelBaseUrl('http://api.example.com/v1'), /HTTPS/)
  assert.throws(() => validateModelBaseUrl('https://user:pass@example.com/v1'), /credentials/)
  assert.equal(validateModelBaseUrl('http://api.example.com/v1', { allowInsecureHttp: true }).protocol, 'http:')
})
