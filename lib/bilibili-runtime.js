import { execFile } from 'node:child_process'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { createBilibiliInboxSource } from './bilibili-inbox-source.js'
import { createBilibiliDmSource } from './bilibili-dm-source.js'
import { createBilibiliLiveSource } from './bilibili-live-source.js'

/**
 * Compose the Bilibili IO adapters behind one platform runtime.
 * The scheduler does not need to know how credentials, CLI processes or live
 * listener processes are configured. Tests/other hosts can inject a runtime.
 */
export function createBilibiliRuntime({
  dshHome,
  biliMjs,
  resolveNodeRuntimeFn = resolveNodeRuntime,
  nodeEnvFn = nodeEnv,
  execFileFn = execFile,
  inboxOptions = {},
} = {}) {
  const nodeExe = resolveNodeRuntimeFn(dshHome)
  const environment = nodeEnvFn(dshHome)

  const runCommand = args => new Promise(resolve => {
    if (!nodeExe) {
      resolve({ ok: false, code: 127, out: '', err: '未找到可用的 node 运行时（设置 DSH_NODE）' })
      return
    }
    execFileFn(nodeExe, [biliMjs, ...args], {
      timeout: 120_000,
      windowsHide: true,
      env: environment,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: Number.isFinite(err?.code) ? err.code : (err ? 3 : 0),
        out: String(stdout ?? ''),
        err: String(stderr ?? ''),
      })
    })
  })

  const comments = createBilibiliInboxSource(inboxOptions)
  const messages = createBilibiliDmSource({ runCommand })
  const liveChat = createBilibiliLiveSource({ nodeExe, biliMjs, nodeEnv: environment, execFileFn })
  const readCommand = async (args, label) => {
    const result = await runCommand(args)
    if (result.code !== 0) {
      const detail = String(result.err || result.out || '').trim().slice(0, 1200)
      throw new Error(label + ' failed (exit ' + String(result.code ?? '?') + ')' + (detail ? ': ' + detail : ''))
    }
    return String(result.out ?? '').slice(0, 14000)
  }
  const content = {
    search: ({ query, page = 1 }) => readCommand(['search', query, String(page)], 'content search'),
    feed: ({ limit = 5 }) => readCommand(['feed', '--n', String(limit)], 'content feed'),
    read: ({ id }) => readCommand(['debrief', id, '--no-frames'], 'content read'),
  }
  return {
    id: 'bilibili',
    capabilities: {
      content: { search: true, feed: true, read: true },
      comments: { read: true },
      messages: { read: true },
      liveChat: { read: true },
    },
    isPaused: () => comments.isPaused(),
    content,
    comments,
    messages,
    liveChat,
  }
}
