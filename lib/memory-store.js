import fs from 'node:fs'
import path from 'node:path'

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_ENTRY_CHARS = 4_000
const MAX_JOURNAL_SCAN_BYTES = 1_000_000

export function createMemoryStore({ stateDir, now = () => new Date().toISOString() } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  const journalFile = path.join(stateDir, 'whale-agent-memory.jsonl')
  const publicDiaryFile = path.join(stateDir, 'whale-diary.md')

  function readEvents() {
    let text = ''
    try {
      const stat = fs.statSync(journalFile)
      const start = Math.max(0, stat.size - MAX_JOURNAL_SCAN_BYTES)
      const fd = fs.openSync(journalFile, 'r')
      try {
        const buffer = Buffer.alloc(stat.size - start)
        fs.readSync(fd, buffer, 0, buffer.length, start)
        text = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Unable to read Whale memory journal')
    }
    return text.split(/\r?\n/).filter(Boolean).map(line => {
      let event
      try { event = JSON.parse(line) } catch {
        throw new Error('Whale memory journal contains a malformed entry; refusing to silently discard history')
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Whale memory journal contains an invalid entry')
      }
      return event
    })
  }

  function findExistingRun(runId) {
    let fd
    try { fd = fs.openSync(journalFile, 'r') } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error('Unable to read Whale memory journal')
    }
    const chunk = Buffer.alloc(64 * 1024)
    let carry = Buffer.alloc(0)
    let found = null
    const parseLine = bytes => {
      if (!bytes.length) return
      const line = bytes.toString('utf8').replace(/\r$/, '')
      let event
      try { event = JSON.parse(line) } catch {
        throw new Error('Whale memory journal contains a malformed entry; refusing to silently discard history')
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Whale memory journal contains an invalid entry')
      }
      if (event.type === 'diary' && event.runId === runId) found = event
    }
    try {
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)
        if (!bytesRead) break
        const data = carry.length
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead)
        let start = 0
        for (let i = 0; i < data.length; i += 1) {
          if (data[i] === 0x0a) {
            parseLine(data.subarray(start, i))
            start = i + 1
          }
        }
        carry = Buffer.from(data.subarray(start))
        if (carry.length > 16 * 1024) throw new Error('Whale memory journal line exceeds the supported size')
      }
      if (carry.length) parseLine(carry)
    } finally {
      fs.closeSync(fd)
    }
    return found
  }

  function recordDiary({ runId, entry, mood = '', visibility = 'private', platform = 'unknown' } = {}) {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new Error('A valid runId is required')
    if (typeof entry !== 'string' || !entry.trim() || entry.length > MAX_ENTRY_CHARS) {
      throw new Error('Diary entry must contain 1–4000 characters')
    }
    if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private or public')
    if (typeof mood !== 'string' || mood.length > 80) throw new Error('mood must be at most 80 characters')
    const existing = findExistingRun(runId)
    if (existing) return { recorded: false, duplicate: true, runId, at: existing.at, visibility: existing.visibility, existingEntry: existing.entry, existingMood: existing.mood }

    const event = {
      schema: 1,
      type: 'diary',
      runId,
      at: now(),
      platform: String(platform).slice(0, 80),
      visibility,
      mood: mood.trim(),
      entry: entry.trim(),
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(journalFile, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 })
    return { recorded: true, duplicate: false, runId, at: event.at, visibility }
  }

  function readDiary({ visibility = 'public', maxChars = 8_000, includeLegacy = true } = {}) {
    if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be public or private')
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20_000) throw new Error('maxChars must be an integer from 100 to 20000')
    const parts = []
    if (visibility === 'public' && includeLegacy) {
      try {
        const legacy = fs.readFileSync(publicDiaryFile, 'utf8').trim()
        if (legacy) parts.push('## Existing public diary\n' + legacy)
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Unable to read existing public diary')
      }
    }
    const entries = readEvents().filter(event => event.type === 'diary' && event.visibility === visibility)
    if (entries.length) {
      parts.push('## Whale Agent diary (' + visibility + ')\n' + entries.slice(-100).map(event => {
        const mood = event.mood ? ' — ' + event.mood : ''
        return '### ' + String(event.at ?? 'unknown time') + mood + '\n' + String(event.entry ?? '')
      }).join('\n\n'))
    }
    const text = parts.join('\n\n')
    return { available: Boolean(text), visibility, text: text.slice(-maxChars), truncated: text.length > maxChars, entries: entries.length }
  }

  return {
    journalFile,
    recordDiary,
    readDiary,
    readPrivateDiary(options = {}) {
      return readDiary({ ...options, visibility: 'private', includeLegacy: false })
    },
    readPublicDiary(options = {}) {
      return readDiary({ ...options, visibility: 'public', includeLegacy: true })
    },
  }
}
