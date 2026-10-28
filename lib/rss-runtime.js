import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_CACHE_MS = 5 * 60_000
const MAX_FEEDS = 10
const MAX_ITEMS_PER_FEED = 100
const MAX_TOTAL_ITEMS = 500

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = Number.parseInt(n, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    })[n])
}

function plainText(value, max = 1200) {
  return decodeEntities(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, max)
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const prefix = name.includes(':') ? '' : '(?:[\\w.-]+:)?'
  const re = new RegExp('<' + prefix + escaped + '\\b[^>]*>([\\s\\S]*?)<\\/' + prefix + escaped + '\\s*>', 'i')
  return re.exec(block)?.[1] ?? ''
}

function attr(block, element, attribute) {
  const elementPrefix = '(?:[\\w.-]+:)?'
  const re = new RegExp('<' + elementPrefix + element + '\\b([^>]*)>', 'i')
  const attrs = re.exec(block)?.[1] ?? ''
  const value = new RegExp('(?:^|\\s)' + attribute + '\\s*=\\s*["\\x27]([^"\\x27]*)["\\x27]', 'i').exec(attrs)?.[1]
  return value ? decodeEntities(value) : ''
}

function blocks(xml, name) {
  const re = new RegExp('<(?:[\\w.-]+:)?' + name + '\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?' + name + '\\s*>', 'gi')
  return xml.match(re) ?? []
}

function parseDate(value) {
  const timestamp = Date.parse(plainText(value, 100))
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function parseFeedXml(xml, source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not allowed')
  const rssItems = blocks(xml, 'item')
  const atomItems = rssItems.length ? [] : blocks(xml, 'entry')
  const entries = rssItems.length ? rssItems : atomItems
  const atom = atomItems.length > 0
  return entries.slice(0, MAX_ITEMS_PER_FEED).map(block => {
    const title = plainText(tag(block, 'title'), 300)
    const link = atom
      ? (blocks(block, 'link').map(node => attr(node, 'link', 'href')).find(Boolean) ?? '')
      : plainText(tag(block, 'link'), 1000)
    const guid = plainText(tag(block, 'guid') || tag(block, 'id'), 500)
    const summary = plainText(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content'), 1200)
    const publishedAt = parseDate(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'date'))
    const author = plainText(tag(block, 'author') || tag(block, 'creator') || tag(block, 'name'), 160)
    const stableKey = guid || link || (title + '|' + (publishedAt ?? ''))
    const id = createHash('sha256').update(source.url + '|' + stableKey).digest('hex').slice(0, 32)
    return { id, platform: 'rss', source: source.name, sourceUrl: source.url, title, url: link, author, publishedAt, summary }
  }).filter(item => item.title && (item.url || item.summary))
}

function ipv4Public(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a,b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0) return false
  if (a === 255) return false
  return true
}

function ipv6Public(address) {
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Public(mapped[1])
  if (normalized === '::' || normalized === '::1') return false
  if (/^(fc|fd|fe[89ab])/i.test(normalized) || normalized.startsWith('ff')) return false
  if (!/^2[0-9a-f]{0,3}:/i.test(normalized) || /^2001:db8:/i.test(normalized)) return false
  return true
}

export async function validatePublicFeedUrl(value, { resolveHost = dnsLookup, allowHttp = false } = {}) {
  let url
  try { url = new URL(value) } catch { throw new Error('RSS feed URL is invalid') }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error('RSS feeds must use HTTPS')
  if (url.username || url.password) throw new Error('RSS feed URL must not contain credentials')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('RSS feed URL uses a disallowed port')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')) {
    throw new Error('RSS feed host is not public')
  }
  if (isIP(host)) throw new Error('RSS feed IP literals are not allowed')
  let addresses
  try { addresses = await resolveHost(host, { all: true, verbatim: true }) } catch {
    throw new Error('RSS feed hostname could not be resolved')
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(item => {
    const type = isIP(item.address)
    return type === 4 ? !ipv4Public(item.address) : type === 6 ? !ipv6Public(item.address) : true
  })) throw new Error('RSS feed host resolves to a non-public address')
  url.hash = ''
  return url
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (declared > maxBytes) throw new Error('RSS response exceeds size limit')
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RSS response exceeds size limit')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('RSS response exceeds size limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createRssRuntime({
  feeds = [],
  fetchImpl = globalThis.fetch,
  resolveHost = dnsLookup,
  now = Date.now,
  cacheMs = DEFAULT_CACHE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowHttp = false,
} = {}) {
  if (!Array.isArray(feeds) || feeds.length === 0 || feeds.length > MAX_FEEDS) {
    throw new TypeError('RSS runtime requires 1–10 configured feeds')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')
  const normalized = feeds.map((feed, index) => {
    if (!feed || typeof feed.name !== 'string' || !feed.name.trim() || typeof feed.url !== 'string') {
      throw new TypeError('Each RSS feed requires a name and URL')
    }
    return { name: feed.name.trim().slice(0, 100), url: feed.url.trim(), index }
  })
  const cache = new Map()
  const inFlight = new Map()

  async function loadFeed(source) {
    const cached = cache.get(source.url)
    if (cached && now() - cached.at < cacheMs) return cached
    if (inFlight.has(source.url)) return inFlight.get(source.url)
    const promise = (async () => {
      const url = await validatePublicFeedUrl(source.url, { resolveHost, allowHttp })
      const response = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' },
      })
      if (!response.ok) throw new Error('RSS request failed with HTTP ' + response.status)
      const xml = await readBoundedBody(response, maxBytes)
      if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('Response is not a supported RSS/Atom XML feed')
      const items = parseFeedXml(xml, source)
      const result = { at: now(), items }
      cache.set(source.url, result)
      return result
    })()
    inFlight.set(source.url, promise)
    try { return await promise } finally { inFlight.delete(source.url) }
  }

  async function collect() {
    const results = await Promise.all(normalized.map(async source => {
      try {
        const result = await loadFeed(source)
        return { source: source.name, ok: true, items: result.items, updatedAt: new Date(result.at).toISOString() }
      } catch (error) {
        return { source: source.name, ok: false, error: String(error?.message ?? error).slice(0, 300) }
      }
    }))
    const items = results.flatMap(result => result.ok ? result.items : [])
      .sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0))
      .slice(0, MAX_TOTAL_ITEMS)
    const failures = results.filter(result => !result.ok)
    if (items.length === 0 && failures.length) {
      throw new Error('All configured RSS feeds failed: ' + failures.map(x => x.source + ': ' + x.error).join('; '))
    }
    return { items, sources: results.map(({ source, ok, updatedAt, error }) => ({ source, ok, ...(updatedAt ? { updatedAt } : {}), ...(error ? { error } : {}) })) }
  }

  return {
    id: 'rss',
    credentialsRequired: false,
    capabilities: { content: { search: true, feed: true, read: true } },
    isPaused: () => false,
    async search({ query, page = 1 } = {}) {
      const q = String(query ?? '').trim().toLocaleLowerCase()
      if (!q || q.length > 120) throw new Error('query must contain 1–120 characters')
      const { items, sources } = await collect()
      const matches = items.filter(item => [item.title, item.summary, item.author, item.source].some(value => String(value ?? '').toLocaleLowerCase().includes(q)))
      const start = (page - 1) * 10
      return { platform: 'rss', query: q, total: matches.length, page, results: matches.slice(start, start + 10), sources }
    },
    async feed({ limit = 5 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer from 1 to 10')
      const { items, sources } = await collect()
      return { platform: 'rss', items: items.slice(0, limit), totalAvailable: items.length, sources }
    },
    async read({ id } = {}) {
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('RSS content ID is invalid')
      const { items } = await collect()
      const item = items.find(candidate => candidate.id === id)
      if (!item) throw new Error('RSS content ID was not found in configured feeds')
      return item
    },
  }
}
