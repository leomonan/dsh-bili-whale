import fs from 'node:fs'
import { credentialsPath } from '../tools/lib/paths.mjs'
import { trafficGuard } from '../tools/lib/traffic.mjs'
import { pullFeed, makeHeaders } from '../tools/lib/msgfeed.mjs'

/**
 * Bilibili-specific inbox IO. Cursor ownership, deduplication, polling cadence,
 * backoff and Agent delivery remain in the scheduler.
 */
export function createBilibiliInboxSource({
  credentialsFile = credentialsPath,
  trafficGuardFactory = trafficGuard,
  pullFeedFn = pullFeed,
  makeHeadersFn = makeHeaders,
} = {}) {
  function readCredentials() {
    return JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
  }

  return {
    isPaused() {
      try {
        const credentials = readCredentials()
        return !!trafficGuardFactory().pauseReason(makeHeadersFn(credentials))
      } catch {
        // Missing/invalid credentials or unavailable protection state must pause network work.
        return true
      }
    },

    async pollComments({ scope = 'both' } = {}) {
      const credentials = readCredentials()
      const headers = makeHeadersFn(credentials)
      const items = [...(await pullFeedFn('reply', { headers, pages: 1 })).items]
      if (String(scope ?? 'both') !== 'reply') {
        items.push(...(await pullFeedFn('at', { headers, pages: 1 })).items)
      }
      return items
    },
  }
}
