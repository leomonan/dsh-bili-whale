import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const MAX_TASKS = 100
const MAX_TASK_CHARS = 2_000
const MAX_RESULT_CHARS = 3_500

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function createControlLeaseStore({ stateDir, memoryStore, now = Date.now } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  if (!memoryStore || typeof memoryStore.recordDiary !== 'function') throw new TypeError('memoryStore.recordDiary is required')
  const stateFile = path.join(stateDir, 'whale-control.json')
  const lockFile = path.join(stateDir, '.whale-control.lock')

  function withLock(fn) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    let fd
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let lock = null
      try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch {}
      if (lock && pidAlive(Number(lock.pid))) throw new Error('Whale control store is busy; retry the operation')
      let age = 0
      try { age = now() - fs.statSync(lockFile).mtimeMs } catch {}
      if (!lock && age < 5_000) throw new Error('Whale control lock is being initialized; retry the operation')
      try { fs.unlinkSync(lockFile) } catch {}
      try { fd = fs.openSync(lockFile, 'wx', 0o600) } catch {
        throw new Error('Whale control store is busy; retry the operation')
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }))
      return fn()
    } finally {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lockFile) } catch {}
    }
  }

  function readState() {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (!value || value.schema !== 1 || !Array.isArray(value.tasks)) throw new Error('invalid schema')
      return value
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, tasks: [] }
      throw new Error('Whale control state is invalid; refusing to discard queued tasks')
    }
  }

  function writeState(state) {
    const temp = stateFile + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, stateFile)
  }

  function expireLeases(state) {
    const current = now()
    let changed = false
    for (const task of state.tasks) {
      if (task.status === 'leased' && Number(task.lease?.expiresAtMs ?? 0) <= current) {
        task.status = 'pending'
        task.lastLeaseExpiredAt = new Date(current).toISOString()
        task.lease = null
        changed = true
      }
    }
    return changed
  }

  function publicTask(task) {
    const { leaseTokenHash, completedByTokenHash, ...safe } = task
    return structuredClone(safe)
  }

  function listTasks({ includeResults = true, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100')
    return withLock(() => {
      const state = readState()
      const changed = expireLeases(state)
      if (changed) writeState(state)
      return state.tasks.slice(-limit).reverse().map(task => {
        const safe = publicTask(task)
        if (!includeResults && safe.result) safe.result = '[omitted]'
        return safe
      })
    })
  }

  function submitTask({ task, kind = 'research', requestedBy = 'agent', requestId } = {}) {
    if (typeof task !== 'string' || !task.trim() || task.trim().length > MAX_TASK_CHARS) {
      throw new Error('task must contain 1–2000 characters')
    }
    if (!['research', 'summarize', 'review', 'plan', 'other'].includes(kind)) throw new Error('unsupported task kind')
    if (typeof requestedBy !== 'string' || !requestedBy.trim() || requestedBy.length > 100) throw new Error('requestedBy must contain 1–100 characters')
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128)) {
      throw new Error('requestId must contain 1–128 characters')
    }
    return withLock(() => {
      const state = readState()
      const changed = expireLeases(state)
      if (requestId) {
        const duplicate = state.tasks.find(item => item.requestId === requestId)
        if (duplicate) {
          if (changed) writeState(state)
          return { created: false, duplicate: true, task: publicTask(duplicate) }
        }
      }
      const pending = state.tasks.filter(item => ['pending', 'leased'].includes(item.status)).length
      if (pending >= MAX_TASKS) throw new Error('Whale task queue is full')
      const at = new Date(now()).toISOString()
      const created = {
        id: randomUUID(),
        requestId: requestId ?? null,
        kind,
        task: task.trim(),
        requestedBy: requestedBy.trim(),
        status: 'pending',
        createdAt: at,
        updatedAt: at,
        lease: null,
        result: null,
      }
      state.tasks.push(created)
      state.tasks = state.tasks.slice(-MAX_TASKS)
      writeState(state)
      return { created: true, duplicate: false, task: publicTask(created) }
    })
  }

  function claimTask({ agentId, taskId, leaseSeconds = 600 } = {}) {
    if (typeof agentId !== 'string' || !agentId.trim() || agentId.length > 100) throw new Error('agentId must contain 1–100 characters')
    if (taskId !== undefined && (typeof taskId !== 'string' || !taskId.trim())) throw new Error('taskId must be a non-empty string')
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 1800) throw new Error('leaseSeconds must be from 60 to 1800')
    return withLock(() => {
      const state = readState()
      const changed = expireLeases(state)
      const active = state.tasks.find(item => item.status === 'leased')
      if (active) {
        if (changed) writeState(state)
        return { claimed: false, reason: 'another task currently holds the Whale control lease', activeTaskId: active.id, expiresAt: active.lease.expiresAt }
      }
      const task = taskId
        ? state.tasks.find(item => item.id === taskId && item.status === 'pending')
        : state.tasks.find(item => item.status === 'pending')
      if (!task) {
        if (changed) writeState(state)
        return { claimed: false, reason: 'no matching pending task' }
      }
      const issuedAtMs = now()
      const expiresAtMs = issuedAtMs + leaseSeconds * 1000
      const token = randomBytes(32).toString('base64url')
      task.status = 'leased'
      task.updatedAt = new Date(issuedAtMs).toISOString()
      task.leaseTokenHash = tokenHash(token)
      task.lease = {
        agentId: agentId.trim(),
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      }
      writeState(state)
      return { claimed: true, task: publicTask(task), leaseToken: token }
    })
  }

  function verifyLease(task, token) {
    if (typeof token !== 'string' || !token) throw new Error('leaseToken is required')
    if (!task || task.status !== 'leased' || !task.lease) throw new Error('task has no active control lease')
    if (task.lease.expiresAtMs <= now()) throw new Error('control lease has expired')
    if (task.leaseTokenHash !== tokenHash(token)) throw new Error('leaseToken is invalid')
  }

  function completeTask({ taskId, leaseToken, result } = {}) {
    if (typeof taskId !== 'string' || !taskId) throw new Error('taskId is required')
    if (typeof result !== 'string' || !result.trim() || result.trim().length > MAX_RESULT_CHARS) {
      throw new Error('result must contain 1–3500 characters')
    }
    return withLock(() => {
      const state = readState()
      const task = state.tasks.find(item => item.id === taskId)
      if (task?.status === 'completed' && task.completedByTokenHash === tokenHash(leaseToken)) {
        return { completed: false, duplicate: true, task: publicTask(task) }
      }
      verifyLease(task, leaseToken)
      const completedAt = new Date(now()).toISOString()
      // Record the handoff result in shared private memory before marking the task complete.
      // If state persistence fails, retry is idempotent by the stable handoff run ID.
      memoryStore.recordDiary({
        runId: 'handoff-' + task.id,
        entry: 'External Agent task (' + task.kind + '): ' + task.task.slice(0, 200) + '\n\nResult:\n' + result.trim().slice(0, 3_300),
        mood: 'collaborative',
        visibility: 'private',
        platform: 'external-agent',
      })
      task.status = 'completed'
      task.updatedAt = completedAt
      task.completedAt = completedAt
      task.result = result.trim()
      task.completedByTokenHash = task.leaseTokenHash
      task.leaseTokenHash = null
      task.lease = null
      writeState(state)
      return { completed: true, duplicate: false, task: publicTask(task) }
    })
  }

  function releaseTask({ taskId, leaseToken } = {}) {
    if (typeof taskId !== 'string' || !taskId) throw new Error('taskId is required')
    return withLock(() => {
      const state = readState()
      const task = state.tasks.find(item => item.id === taskId)
      verifyLease(task, leaseToken)
      task.status = 'pending'
      task.updatedAt = new Date(now()).toISOString()
      task.lastReleasedBy = task.lease.agentId
      task.lease = null
      task.leaseTokenHash = null
      writeState(state)
      return { released: true, task: publicTask(task) }
    })
  }

  function activeLease() {
    return withLock(() => {
      const state = readState()
      const changed = expireLeases(state)
      if (changed) writeState(state)
      const task = state.tasks.find(item => item.status === 'leased')
      return task ? { taskId: task.id, agentId: task.lease.agentId, expiresAt: task.lease.expiresAt } : null
    })
  }

  return {
    listTasks,
    submitTask,
    claimTask,
    completeTask,
    releaseTask,
    activeLease,
    hasActiveLease: () => Boolean(activeLease()),
  }
}
