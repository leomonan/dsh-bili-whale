import path from 'node:path'
import { createRssRuntime } from './rss-runtime.js'

export async function loadPlatformRuntime({
  platformId = String(process.env.WHALE_PLATFORM ?? 'bilibili').trim().toLowerCase(),
  root,
  userHome,
  dataHome,
  env = process.env,
} = {}) {
  if (!root || !userHome) throw new TypeError('root and userHome are required')

  if (platformId === 'rss') {
    const home = dataHome || env.WHALE_HOME || path.join(userHome, '.whale-agent')
    let feeds
    try {
      feeds = JSON.parse(env.WHALE_RSS_FEEDS ?? '[]')
    } catch {
      throw new Error('WHALE_RSS_FEEDS must be a JSON array of {name,url} objects')
    }
    return {
      platformId,
      dataHome: home,
      credentialsFile: null,
      platformRuntime: createRssRuntime({
        feeds,
        allowHttp: env.WHALE_RSS_ALLOW_HTTP === '1',
      }),
    }
  }

  if (platformId === 'bilibili') {
    const requestedHome = dataHome || env.WHALE_HOME || env.DSH_HOME || path.join(userHome, '.dsh')
    // Legacy Bilibili tools resolve paths at module load; select the data home before importing them.
    env.DSH_HOME = requestedHome
    const [{ DSH_HOME, credentialsPath }, { createBilibiliRuntime }] = await Promise.all([
      import('../tools/lib/paths.mjs'),
      import('./bilibili-runtime.js'),
    ])
    return {
      platformId,
      dataHome: DSH_HOME,
      credentialsFile: credentialsPath,
      platformRuntime: createBilibiliRuntime({
        dshHome: DSH_HOME,
        biliMjs: path.join(root, 'tools', 'bili.mjs'),
      }),
    }
  }

  throw new Error('Unsupported WHALE_PLATFORM: ' + platformId + ' (supported: bilibili, rss)')
}
