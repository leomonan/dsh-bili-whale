import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * Bilibili live-room process adapter. Event interpretation, delivery, retry and
 * stop/restart decisions remain owned by the scheduler.
 */
export function createBilibiliLiveSource({ nodeExe, biliMjs, nodeEnv, execFileFn = execFile } = {}) {
  return {
    start({ room, scope = 'owner', operatorUid, onExit }) {
      if (!nodeExe) return null
      if (typeof biliMjs !== 'string' || !biliMjs) throw new TypeError('biliMjs is required')
      if (typeof onExit !== 'function') throw new TypeError('onExit is required')
      const script = path.join(path.dirname(biliMjs), 'commands', 'danmaku-await.mjs')
      const args = [script, '--room', String(room)]
      if (String(scope) === 'owner' && operatorUid) args.push('--operator-uid', String(operatorUid))
      return execFileFn(nodeExe, args, {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: nodeEnv,
        cwd: path.dirname(biliMjs),
      }, onExit)
    },
  }
}
