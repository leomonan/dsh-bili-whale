import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createRssRuntime, validatePublicFeedUrl } from '../lib/rss-runtime.js'

const rssXml = [
  '<?xml version="1.0"?>',
  '<rss version="2.0"><channel><title>Engineering Feed</title>',
  '<item><title>Release &amp; Reliability</title><link>https://example.com/posts/1</link><guid>post-1</guid><description><![CDATA[<p>Safe <b>release</b> notes</p>]]></description><pubDate>Tue, 28 Oct 2026 10:00:00 GMT</pubDate><author>Whale Team</author></item>',
  '<item><title>Second article</title><link>https://example.com/posts/2</link><guid>post-2</guid><description>Plain summary</description><pubDate>Mon, 27 Oct 2026 10:00:00 GMT</pubDate></item>',
  '</channel></rss>',
].join('\n')

const atomXml = [
  '<?xml version="1.0"?>',
  '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Source</title>',
  '<entry><title>Atom story</title><id>tag:example.com,2026:story</id><link rel="alternate" href="https://example.com/atom/1"/><summary>Atom summary</summary><updated>2026-10-28T10:00:00Z</updated><author><name>Atom Author</name></author></entry>',
  '</feed>',
].join('\n')

function response(xml, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(xml)) : 'application/rss+xml' },
    body: null,
    async text() { return xml },
  }
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
function runtime(t, options = {}) {
  let currentTime = options.now ?? Date.parse('2026-10-29T00:00:00Z')
  const calls = []
  const sources = options.feeds ?? [{ name: 'Engineering', url: 'https://feeds.example.com/rss.xml' }]
  const rss = createRssRuntime({
    feeds: sources,
    resolveHost: options.resolveHost ?? publicResolver,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (options.fetchImpl) return options.fetchImpl(url, init)
      return response(options.xml ?? rssXml)
    },
    now: () => currentTime,
    cacheMs: options.cacheMs ?? 300_000,
    failureCacheMs: options.failureCacheMs,
    maxBytes: options.maxBytes,
  })
  return { rss, calls, advance(ms) { currentTime += ms } }
}

test('RSS runtime parses RSS 2.0 entries into stable, bounded normalized content', async t => {
  const f = runtime(t)
  const result = await f.rss.content.feed({ limit: 10 })
  assert.equal(result.platform, 'rss')
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].title, 'Release & Reliability')
  assert.equal(result.items[0].summary, 'Safe release notes')
  assert.equal(result.items[0].author, 'Whale Team')
  assert.match(result.items[0].id, /^[a-f0-9]{32}$/)
  assert.equal(result.items[0].platform, 'rss')
  assert.equal(result.items[0].url, 'https://example.com/posts/1')
  assert.equal(result.sources[0].ok, true)
  const again = await f.rss.content.feed({ limit: 10 })
  assert.equal(again.items[0].id, result.items[0].id)
  assert.equal(f.calls.length, 1, 'fresh feed cache prevents repeated upstream requests')
  assert.equal(f.calls[0].init.redirect, 'error')
})

test('RSS runtime supports Atom self-closing links and nested author names', async t => {
  const f = runtime(t, { xml: atomXml })
  const result = await f.rss.content.feed()
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].title, 'Atom story')
  assert.equal(result.items[0].url, 'https://example.com/atom/1')
  assert.equal(result.items[0].author, 'Atom Author')
  assert.equal(result.items[0].summary, 'Atom summary')
})

test('search and read share stable content IDs and return explicit source information', async t => {
  const f = runtime(t)
  const search = await f.rss.content.search({ query: 'reliability', page: 1 })
  assert.equal(search.total, 1)
  const item = search.results[0]
  const read = await f.rss.content.read({ id: item.id })
  assert.deepEqual(read, item)
  assert.equal((await f.rss.content.search({ query: 'not-present' })).total, 0)
  await assert.rejects(f.rss.content.read({ id: 'invalid' }), /invalid/)
})

test('RSS cache expires and fetches fresh content after its TTL', async t => {
  const f = runtime(t, { cacheMs: 1000 })
  await f.rss.content.feed()
  f.advance(1001)
  await f.rss.content.feed()
  assert.equal(f.calls.length, 2)
})

test('RSS reports partial source failures and throws when every source fails', async t => {
  let calls = 0
  const f = runtime(t, {
    feeds: [
      { name: 'good', url: 'https://good.example.com/feed' },
      { name: 'bad', url: 'https://bad.example.com/feed' },
    ],
    fetchImpl: async url => {
      calls += 1
      if (url.includes('bad.')) throw new Error('upstream unavailable')
      return response(rssXml)
    },
  })
  const result = await f.rss.content.feed()
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.sources.map(x => x.ok), [true, false])
  assert.match(result.sources[1].error, /upstream unavailable/)
  assert.equal(calls, 2)

  const failed = runtime(t, { fetchImpl: async () => { throw new Error('offline') } })
  await assert.rejects(failed.rss.content.feed(), /All configured RSS feeds failed/)
})

test('RSS rejects local hosts, IP literals, credentials, unsupported schemes and nonstandard ports', async () => {
  for (const url of [
    'http://example.com/feed',
    'file:///etc/passwd',
    'https://user:pass@example.com/feed',
    'https://127.0.0.1/feed',
    'https://[::1]/feed',
    'https://localhost/feed',
    'https://service.local/feed',
    'https://example.com:8443/feed',
  ]) {
    await assert.rejects(validatePublicFeedUrl(url, { resolveHost: publicResolver }), undefined, url)
  }
})

test('RSS rejects DNS answers that include any non-public address', async () => {
  await assert.rejects(
    validatePublicFeedUrl('https://feeds.example.com/rss', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }],
    }),
    /non-public address/,
  )
  await assert.rejects(
    validatePublicFeedUrl('https://feeds.example.com/rss', { resolveHost: async () => { throw new Error('DNS failed') } }),
    /could not be resolved/,
  )
})

test('RSS rejects DTD/entity declarations and oversized payloads', async t => {
  const dtd = runtime(t, { xml: '<!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel></channel></rss>' })
  await assert.rejects(dtd.rss.content.feed(), /DTD\/entity/)
  const huge = runtime(t, { xml: '<rss>' + 'x'.repeat(2000) + '</rss>', maxBytes: 100 })
  await assert.rejects(huge.rss.content.feed(), /size limit/)
})

test('RSS enforces feed count, query and result limits', async t => {
  assert.throws(() => createRssRuntime({ feeds: [] }), /1–10/)
  assert.throws(() => createRssRuntime({ feeds: Array.from({ length: 11 }, (_, i) => ({ name: String(i), url: 'https://example.com/' + i })) }), /1–10/)
  const f = runtime(t)
  await assert.rejects(f.rss.content.search({ query: '  ' }), /1–120/)
  await assert.rejects(f.rss.content.feed({ limit: 11 }), /limit/)
})


test('RSS source failures are briefly cached to avoid hammering a failing host', async t => {
  const f = runtime(t, {
    failureCacheMs: 1000,
    fetchImpl: async () => { throw new Error('temporarily offline') },
  })
  await assert.rejects(f.rss.content.feed(), /All configured RSS feeds failed/)
  await assert.rejects(f.rss.content.feed(), /All configured RSS feeds failed/)
  assert.equal(f.calls.length, 1)
  f.advance(1001)
  await assert.rejects(f.rss.content.feed(), /All configured RSS feeds failed/)
  assert.equal(f.calls.length, 2)
})


test('default RSS transport pins the socket to the validated IP while preserving Host and TLS SNI', async () => {
  let captured
  let requests = 0
  const runtime = createRssRuntime({
    feeds: [{ name: 'Pinned', url: 'https://feeds.example.com/rss.xml' }],
    resolveHost: publicResolver,
    requestImpl: (options, callback) => {
      captured = options
      requests += 1
      const req = new EventEmitter()
      req.setTimeout = () => {}
      req.destroy = error => req.emit('error', error)
      req.end = () => {
        const res = Readable.from([Buffer.from(rssXml)])
        res.statusCode = 200
        res.headers = {
          'content-type': 'application/rss+xml',
          'content-length': String(Buffer.byteLength(rssXml)),
        }
        callback(res)
      }
      return req
    },
  })
  const result = await runtime.content.feed()
  assert.equal(result.items.length, 2)
  assert.equal(requests, 1)
  assert.equal(captured.hostname, '93.184.216.34')
  assert.equal(captured.servername, 'feeds.example.com')
  assert.equal(captured.headers.host, 'feeds.example.com')
  assert.equal(captured.protocol, 'https:')
})

test('default RSS transport refuses redirects rather than resolving a second destination', async () => {
  let requests = 0
  const runtime = createRssRuntime({
    feeds: [{ name: 'Redirect', url: 'https://feeds.example.com/rss.xml' }],
    resolveHost: publicResolver,
    requestImpl: (_options, callback) => {
      const req = new EventEmitter()
      req.setTimeout = () => {}
      req.destroy = error => req.emit('error', error)
      req.end = () => {
        requests += 1
        const res = Readable.from(['redirect'])
        res.statusCode = 302
        res.headers = { location: 'http://127.0.0.1/private', 'content-length': '8' }
        callback(res)
      }
      return req
    },
  })
  await assert.rejects(runtime.content.feed(), /HTTP 302/)
  assert.equal(requests, 1)
})

test('asynchronous bodyless or invalid RSS responses fail without crashing the process', async () => {
  for (const status of [204, 205, 304, 101]) {
    const runtime = createRssRuntime({
      feeds: [{ name: 'Bodyless', url: 'https://feeds.example.com/rss.xml' }],
      resolveHost: publicResolver,
      requestImpl: (_options, callback) => {
        const req = new EventEmitter()
        req.setTimeout = () => {}
        req.destroy = error => req.emit('error', error)
        req.end = () => setImmediate(() => {
          const res = Readable.from([])
          res.statusCode = status
          res.headers = {}
          callback(res)
        })
        return req
      },
    })
    const expected = status === 304 ? /HTTP 304/ : status === 101 ? /All configured RSS feeds failed/ : /not a supported RSS\/Atom XML feed/
    await assert.rejects(runtime.content.feed(), expected)
  }
})
