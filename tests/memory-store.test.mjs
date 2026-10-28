import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryStore } from '../lib/memory-store.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = '2026-10-29T00:00:00.000Z'
  const store = createMemoryStore({ stateDir: dir, now: () => now })
  return { dir, store, setNow(value) { now = value } }
}

test('memory journal records private entries and reads them only through private diary API', t => {
  const f = fixture(t)
  const result = f.store.recordDiary({ runId: 'run-1', entry: 'I learned about RSS feeds.', mood: 'curious', platform: 'rss' })
  assert.equal(result.recorded, true)
  assert.equal(result.visibility, 'private')
  assert.match(f.store.readPrivateDiary().text, /I learned about RSS feeds/)
  assert.equal(f.store.readPublicDiary().text.includes('I learned about RSS feeds'), false)
  const event = JSON.parse(fs.readFileSync(f.store.journalFile, 'utf8').trim())
  assert.equal(event.runId, 'run-1')
  assert.equal(event.type, 'diary')
  assert.equal(event.visibility, 'private')
})

test('memory journal supports public entries and preserves legacy public diary read access', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.dir, 'whale-diary.md'), 'Legacy public diary entry')
  f.store.recordDiary({ runId: 'run-public', entry: 'A public note', visibility: 'public', mood: 'calm' })
  const publicDiary = f.store.readPublicDiary()
  assert.match(publicDiary.text, /Legacy public diary entry/)
  assert.match(publicDiary.text, /A public note/)
  assert.equal(f.store.readPrivateDiary().text.includes('A public note'), false)
})

test('one run ID can record at most one diary entry, even after a retry', t => {
  const f = fixture(t)
  const first = f.store.recordDiary({ runId: 'same-run', entry: 'First note' })
  const duplicate = f.store.recordDiary({ runId: 'same-run', entry: 'Different note' })
  assert.equal(first.recorded, true)
  assert.equal(duplicate.recorded, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(f.store.readPrivateDiary().entries, 1)
  assert.doesNotMatch(f.store.readPrivateDiary().text, /Different note/)
})

test('memory journal validates run ID, entry, visibility and bounds diary reads', t => {
  const f = fixture(t)
  assert.throws(() => f.store.recordDiary({ runId: '', entry: 'x' }), /runId/)
  assert.throws(() => f.store.recordDiary({ runId: 'run', entry: '  ' }), /1–4000/)
  assert.throws(() => f.store.recordDiary({ runId: 'run', entry: 'x', visibility: 'external' }), /visibility/)
  assert.throws(() => f.store.readPrivateDiary({ maxChars: 10 }), /maxChars/)
})

test('memory journal reports empty state without creating files', t => {
  const f = fixture(t)
  assert.deepEqual(f.store.readPublicDiary(), {
    available: false, visibility: 'public', text: '', truncated: false, entries: 0,
  })
  assert.equal(fs.existsSync(f.store.journalFile), false)
})


test('memory journal corruption is reported instead of silently losing history', t => {
  const f = fixture(t)
  fs.writeFileSync(f.store.journalFile, '{"type":"diary","runId":"ok"}\nnot-json\n')
  assert.throws(() => f.store.readPrivateDiary(), /malformed entry/)
})


test('diary run idempotency survives journals larger than the bounded read window', t => {
  const f = fixture(t)
  const first = f.store.recordDiary({ runId: 'old-run', entry: 'Original durable result.' })
  assert.equal(first.recorded, true)
  const padding = JSON.stringify({ type: 'other', pad: 'x'.repeat(4000) }) + '\n'
  fs.appendFileSync(f.store.journalFile, padding.repeat(300))
  assert.ok(fs.statSync(f.store.journalFile).size > 1_000_000)
  const retry = f.store.recordDiary({ runId: 'old-run', entry: 'Conflicting retry must not append.' })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.existingEntry, 'Original durable result.')
})
