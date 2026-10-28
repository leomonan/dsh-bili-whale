function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function validateModelBaseUrl(value, { allowInsecureHttp = false } = {}) {
  let url
  try { url = new URL(value) } catch { throw new Error('WHALE_MODEL_BASE_URL must be a valid URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('Model base URL must not contain credentials, query, or fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLoopback(url.hostname) || allowInsecureHttp))) {
    throw new Error('Model API must use HTTPS; HTTP is allowed only for loopback or explicit opt-in')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

export function createOpenAICompatibleModelClient({
  apiKey = process.env.WHALE_MODEL_API_KEY || process.env.OPENAI_API_KEY,
  baseUrl = process.env.WHALE_MODEL_BASE_URL || 'https://api.openai.com/v1',
  model = process.env.WHALE_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  allowInsecureHttp = process.env.WHALE_MODEL_ALLOW_HTTP === '1',
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set WHALE_MODEL_API_KEY (or OPENAI_API_KEY) for autonomous mode')
  if (typeof model !== 'string' || !model.trim()) throw new Error('Set WHALE_MODEL to the fixed model identifier for autonomous mode')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')
  const base = validateModelBaseUrl(baseUrl, { allowInsecureHttp })

  return {
    model: model.trim(),
    async complete({ messages, tools, signal, temperature = 0.4, maxTokens = 1800 } = {}) {
      if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages are required')
      const body = {
        model: model.trim(),
        messages,
        temperature,
        max_tokens: maxTokens,
      }
      if (Array.isArray(tools) && tools.length) {
        body.tools = tools
        body.tool_choice = 'auto'
      }
      let response
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
        response = await fetchImpl(new URL('chat/completions', base), {
          method: 'POST',
          redirect: 'error',
          signal: combinedSignal,
          headers: {
            authorization: 'Bearer ' + apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (error) {
        if (signal?.aborted) throw new Error('Model request cancelled')
        throw new Error('Model request failed: ' + String(error?.message ?? error).slice(0, 300))
      }
      if (!response.ok) {
        let detail = ''
        try { detail = String(await response.text()).slice(0, 800) } catch {}
        throw new Error('Model API returned HTTP ' + response.status + (detail ? ': ' + detail : ''))
      }
      let payload
      try { payload = await response.json() } catch { throw new Error('Model API returned invalid JSON') }
      const message = payload?.choices?.[0]?.message
      if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
        throw new Error('Model API response has no assistant message or tool calls')
      }
      return {
        message,
        usage: payload.usage ?? null,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        model: payload.model ?? model.trim(),
      }
    },
  }
}
