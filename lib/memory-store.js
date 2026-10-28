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
    return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try {
        const event = JSON.parse(line)
        return event && typeof event === 'object' ? [event] : []
      } catch { return [] }
    })
  }

  function recordDiary({ runId, entry, mood = '', visibility = 'private', platform = 'unknown' } = {}) {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new Error('A valid runId is required')
    if (typeof entry !== 'string' || !entry.trim() || entry.length > MAX_ENTRY_CHARS) {
      throw new Error('Diary entry must contain 1–4000 characters')
    }
    if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private or public')
    if (typeof mood !== 'string' || mood.length > 80) throw new Error('mood must be at most 80 characters')
    const events = readEvents()
    const existing = events.find(event => event.type === 'diary' && event.runId === runId)
    if (existing) return { recorded: false, duplicate: true, runId, at: existing.at, visibility: existing.visibility }

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
