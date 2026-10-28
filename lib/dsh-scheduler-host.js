import fs from 'node:fs'
import path from 'node:path'
import { createDshSessionTransport } from './dsh-session-transport.js'
import { createBilibiliWorkflows } from './bilibili-workflows.js'
import { HOME } from '../tools/lib/paths.mjs'
import { startScheduler } from './scheduler.js'

/** DSH-specific session/activity adapter. The scheduler sees only capabilities. */
export function createDshSchedulerHost({ ctx, dshHome, cwd, sessionId = 'bili-whale', now = Date.now, idleMs = 90_000 } = {}) {
  if (!ctx || !dshHome) throw new TypeError('ctx and dshHome are required')
  let activeSessionId = sessionId
  let cachedSessionFile = null

  function findSessionFile() {
    const root = path.join(dshHome, 'sessions')
    const stack = [root]
    let best = null
    let visited = 0
    while (stack.length && visited < 5000) {
      const directory = stack.pop()
      visited += 1
      let entries = []
      try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) stack.push(file)
        else if (entry.name === 'session.v4.jsonl.zstd' && file.includes(activeSessionId)) {
          try { const mtimeMs = fs.statSync(file).mtimeMs; if (!best || mtimeMs > best.mtimeMs) best = { path: file, mtimeMs } } catch {}
        }
      }
    }
    return best
  }

  return {
    transport: createDshSessionTransport({ controller: ctx.sessionController, cwd }),
    canDeliver() { return !!ctx.sessionController },
    setSessionId(id) { if (activeSessionId !== id) { activeSessionId = id; cachedSessionFile = null } },
    isSessionBusy() {
      if (!cachedSessionFile) cachedSessionFile = findSessionFile()
      if (!cachedSessionFile) return false
      try { if (now() - fs.statSync(cachedSessionFile.path).mtimeMs < idleMs) return 'still-working' } catch {}
      return false
    },
  }
}

/** Compatibility entrypoint used only by the DSH plugin host. */
export function startDshScheduler(ctx, opts) {
  const host = createDshSchedulerHost({ ctx, dshHome: opts.dshHome, cwd: opts.cwd, sessionId: opts.sessionId ?? 'bili-whale' })
  const configFile = process.env.BILI_WHALE_CONFIG || path.join(opts.dshHome, 'bili-whale.config.json')
  const workflows = opts.workflows ?? createBilibiliWorkflows({ configFile, homeDir: HOME })
  return startScheduler(host, { ...opts, homeDir: HOME, workflows })
}
