#!/usr/bin/env node
import { createOpenAICompatibleModelClient } from '../lib/model-client.js'

if (process.env.WHALE_RUN_PAID_PROVIDER_SMOKE !== '1') {
  process.stderr.write('[whale-agent] Provider smoke test is opt-in. Set WHALE_RUN_PAID_PROVIDER_SMOKE=1 to authorize one small model API request.\\n')
  process.exitCode = 2
} else {
  const apiKey = process.env.WHALE_MODEL_API_KEY || process.env.OPENAI_API_KEY || ''
  try {
    const client = createOpenAICompatibleModelClient()
    const result = await client.complete({
      messages: [
        { role: 'system', content: 'This is a protocol smoke test. Call exactly the function whale_provider_smoke with an empty JSON object. Do not answer in natural language.' },
        { role: 'user', content: 'Return the diagnostic tool call now.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'whale_provider_smoke',
          description: 'Non-mutating diagnostic function. It is not executed and has no side effects.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }],
      temperature: 0,
      maxTokens: 96,
    })
    const calls = result.message?.tool_calls
    if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== 'whale_provider_smoke') {
      throw new Error('provider did not return the expected single tool call')
    }
    let args
    try { args = JSON.parse(calls[0].function.arguments ?? '{}') } catch {
      throw new Error('provider returned malformed tool-call arguments')
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
      throw new Error('provider returned unexpected diagnostic arguments')
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      model: result.model,
      toolCall: calls[0].function.name,
      usage: result.usage ? {
        prompt_tokens: result.usage.prompt_tokens ?? null,
        completion_tokens: result.usage.completion_tokens ?? null,
        total_tokens: result.usage.total_tokens ?? null,
      } : null,
    }) + '\\n')
  } catch (error) {
    const message = String(error?.message ?? error)
      .replaceAll(apiKey, apiKey ? '[redacted]' : '')
      .slice(0, 500)
    process.stderr.write('[whale-agent] Provider smoke failed: ' + message + '\\n')
    process.exitCode = 1
  }
}
