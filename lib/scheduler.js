import { createSessionDelivery } from './session-delivery.js'
import { assertPlatformRuntime } from './platform-runtime-contract.js'
import { pollDelay } from '../tools/lib/poll-policy.mjs'
/**
 * 自主生物钟（2026-10-18 加，主人要求）——
 *
 * 为什么要有它：以前"醒来"要靠**有人在对话框里挂 clock** ✗ —— 那不是"她活在过日子"，
 * 是"你戳一下她动一下" ✗。主人明确要求：**计划要她自己执行，改配置要立刻生效** ✓。
 *
 * 做法（不需要任何外部 CLI）：
 *   · 插件宿主**常驻在 DSH 里** → 自己每 60 秒 tick 一次 ✓
 *   · tick 与 `bili.mjs night plan` 共用同一个计划引擎，持久化绝对时间与窗口记录
 *   · 到点了 → 用 **`ctx.sessionController.prompt({ sessionId, mode:'queue', content:[…] })`**
 *     往她自己的专用会话里塞一个"你醒了"的回合 ✓ → agent 真的醒来干活 ✓
 *   · 醒来后立刻标记 `woke` → 下一次 tick 自动排下一趟（多窗口 × 多次 ✓）
 *   · 只有作息修改才清除计划；历史计数保留，修改其它设置不会重新抽签
 *
 * 为什么用"她自己的会话"：`sessionId` 固定（默认 bili-whale）→ 跨天保留她的上下文，
 *   而不是每天开一个新会话、每天忘光 ✗。
 */
import fs from 'node:fs'
import path from 'node:path'
// 收件箱读取复用工具链的实现（避免在插件里再抄一份 B站 接口 ✓）
import { makePlan, completePlan, historyOf, inWindow as isInWindow } from '../tools/lib/night-plan.mjs'




const TICK_MS = 60_000
const LISTEN_STATE = 'whale-listen.json'

export function startScheduler(host, opts) {
  if (!host || !host.transport || typeof host.canDeliver !== 'function' || typeof host.isSessionBusy !== 'function' || typeof host.setSessionId !== 'function') {
    throw new TypeError('host must provide transport, canDeliver(), isSessionBusy(), and setSessionId()')
  }
  const {
    stateDir, configFile, homeDir,
    readNightConfig: readNightConfigFn,
    platformRuntime, workflows,
    sessionId = 'bili-whale', log = () => {},
  } = opts
  if (!stateDir || !configFile || !homeDir || typeof readNightConfigFn !== 'function') {
    throw new TypeError('stateDir, configFile, homeDir, and readNightConfig are required')
  }
  const platform = assertPlatformRuntime(platformRuntime)
  const capabilities = platform.capabilities ?? {}
  const requiredWorkflows = ['wakePrompt', 'pausedPrompt', 'skipPrompt']
  if (capabilities.comments?.read) requiredWorkflows.push('commentPrompt')
  if (capabilities.messages?.read) requiredWorkflows.push('dmPrompt')
  if (capabilities.liveChat?.read) requiredWorkflows.push('livePrompt')
  if (!workflows || requiredWorkflows.some(name => typeof workflows[name] !== 'function')) {
    throw new TypeError('workflows do not satisfy the selected platform capabilities')
  }

  const STATE = path.join(stateDir, 'whale-night.json')
  const CFG_FILE_REF = configFile
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  // 2026-10-22：tick() 里拿不到别处闭包的 cfg ✗（实测 ReferenceError: cfg is not defined）
  //   给一个「每次现读」的小函数 —— 顺带好处：设置页一保存，下一次唤醒就用新值 ✓
  const readCfgNow = () => { try { return JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch { return {} } }
  // Platform-specific inbox IO is injected; scheduler owns cursors, backoff and delivery semantics.
  const writeState = (o) => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    const temp = STATE + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(o, null, 2) + '\n')
    fs.renameSync(temp, STATE)
  }

  // Platform IO and workflow implementations are injected by the selected host adapter.
  // Platform IO and workflow implementations are injected by the selected host adapter.


  const lifecycle = new AbortController()
  let waking = false
  let wakingAt = 0
  let wakingWarned = false
  // The host adapter reports actual host activity; the scheduler owns its cooldown.
  let busyUntil = 0
  const COOLDOWN_MS = 8 * 60 * 1000
  function sheIsBusy() {
    if (Date.now() < busyUntil) return 'cooldown'
    return host.isSessionBusy()
  }

  let stopped = false
  let resetAfterDelivery = false
  async function tick() {
    // A timeout is not proof of failed delivery. Keep single-flight ownership
    // until the existing operation settles; do not enqueue the same work again.
    if (waking) {
      if (!wakingWarned && Date.now() - wakingAt > 15 * 60_000) {
        wakingWarned = true
        log('[bili-whale] 生物钟唤醒等待超时：结果未确认，保留任务锁以避免重复投递；请检查宿主会话，勿直接重发')
      }
      return
    }
    if (stopped || waking || !host.canDeliver() || sheIsBusy()) return
    waking = true
    wakingAt = Date.now()
    wakingWarned = false
    try {
      const st = makePlan(readNightConfigFn(), readState() ?? {})
      writeState(st)
      if (st.action === 'done' || Date.now() < st.atMs) return
      if (stopped) return
      if (stopped) return
      const text = platform.isPaused() ? workflows.pausedPrompt() : st.action === 'skip' ? workflows.skipPrompt(st) : workflows.wakePrompt(st, personaLine(), Number(readCfgNow().night?.maxVideos ?? 5) || 5, String(readCfgNow().share?.via ?? 'dm'))
      await delivery.send({ requestId: 'bili-whale-' + Date.now(), sessionId,
        mode: 'queue', content: [{ type: 'text', text }] }, lifecycle.signal)
      const completed = completePlan(st)
      writeState(resetAfterDelivery ? historyOf(completed) : completed)
      resetAfterDelivery = false
      busyUntil = Date.now() + COOLDOWN_MS
      log('[bili-whale] 已投递 ' + st.action + ' · ' + st.atText)
    } catch (e) { log('[bili-whale] 唤醒失败，下一轮重试：' + e.message) }
    finally {
      // A settings save while ensureSession/prompt was in flight must survive failure too.
      if (resetAfterDelivery) { writeState(historyOf(readState() ?? {})); resetAfterDelivery = false }
      waking = false
    }
  }

  // ── 全天监听（2026-10-18 加）：插件自己轮询收件箱，有人找她就叫醒她 ────────────────
  // 为什么放这里：`listen.allDay` 只控制"守多久" ✓，但**没人启动 listener** ✗ —— 跟生物钟当初的病一样。
  // 现在插件每 listen.commentIntervalSec 秒看一眼「回复我的 / @我的」；有新东西就 prompt 她一次。
  const LSTATE = path.join(stateDir, LISTEN_STATE)
  const readL = () => { try { return JSON.parse(fs.readFileSync(LSTATE, 'utf8')) } catch { return null } }
  const writeL = (o) => { try { fs.mkdirSync(path.dirname(LSTATE), { recursive: true }); fs.writeFileSync(LSTATE, JSON.stringify(o, null, 2) + '\n') } catch {} }
  const inWindow = cfg => isInWindow(cfg?.night ?? {})

  let listening = false
  let listeningAt = 0
  let listeningWarned = false
  let lastListenAt = 0
  let commentFailures = 0
  // 直播间监听（2026-10-18 加）：插件替主人管着 `danmaku await` ✓
  let liveProc = null
  let liveRetryAt = 0
  let liveWaking = false
  let liveStopping = false   // 主动停（关开关）→ 退出回调不要当成"异常退出" ✗
  let liveRoomNow = ''       // 当前在听的房间号（用于检测"主人换了房间" ✓）
    // ── 私信监听（2026-10-19）──────────────────────────────────────
    //   只认主人那一个会话 ✓ 系统通知/陌生人一律忽略 ✗
    //   你不说话 = 没有新私信 = 不叫醒 = 零 token ✓（主人设计的低风险互动 ✓）
    let dmBusy = false
    let dmBusyAt = 0
  let dmBusyWarned = false
    let lastDmAt = 0
    let dmFailures = 0
    // ── 身份注入（2026-10-19）────────────────────────────────────
    //   设置页「她是谁」那三个字段以前只是存着，没有任何代码读 ✗
    //   现在每次叫醒她，把这段塞到提示最前面 → 她真的按配置称呼自己/主人 ✓
    const personaBlock = () => {
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch {}
      const p = cfg.persona ?? {}
      const bits = []
      if (p.name) bits.push(`你是「${p.name}」`)
      if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
      if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
      // 2026-10-21：附上她专属的人设（~/.bili-ai/persona.md）—— 只影响她，不影响别的会话 ✓
      let extra = ``
      try {
        const pf = path.join(homeDir, '.bili-ai', 'persona.md')
        const txt = fs.readFileSync(pf, 'utf8').trim()
        // 2026-10-21：人设文件优先 —— 否则会和设置里的「名字/自称」打架 ✗
        //   （实测：设置说"自称本小姐"，人设说"自称我" → 她会摇摆）
        if (txt) extra = `\n\n［她的人设］以下是她专属的设定，写日记 / 说话 / 选题都以它为准；与上面［身份］里的名字/称呼/自称冲突时，以这一份为准 ✓：\n${txt.slice(0, 20000)}`
      } catch {}
      const base = bits.length ? `［身份］${bits.join("，")}。（以此为准，别用别的称呼 ✓）` : ""
      return base + extra
    }


  const personaLine = () => '' // Added at delivery time, after session selection.
  const delivery = createSessionDelivery({
    transport: host.transport,
    stateDir,
    personaPath: path.join(homeDir, '.bili-ai', 'persona.md'),
    diaryPaths: [
      path.join(stateDir, 'whale-diary.md'),
      path.join(stateDir, 'whale-diary-private.md'),
    ],
    sessionId,
    config: readCfgNow,
    persona: personaBlock,
    isBusy: sheIsBusy,
    log,
    onSession: id => host.setSessionId(id),
  })

    async function dmTick() {
    // A timeout is not proof of failed delivery. Keep single-flight ownership
    // until the existing operation settles; do not enqueue the same work again.
    if (dmBusy) {
      if (!dmBusyWarned && Date.now() - dmBusyAt > 5 * 60_000) {
        dmBusyWarned = true
        log('[bili-whale] 私信监听等待超时：结果未确认，保留任务锁以避免重复投递；请检查宿主会话，勿直接重发')
      }
      return
    }
      if (stopped || dmBusy) return
      if (!capabilities.messages?.read) { dmFailures = 0; lastDmAt = 0; return }
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch { cfg = {} }
      const L = cfg.listen ?? {}
      if (!L.dm) {
        // 2026-10-24：关掉私信监听时把退避计数清零 ✓
        //   否则关一会儿再打开，第一次轮询还要按旧 dmFailures 等最多 15 分钟 ✗
        dmFailures = 0; lastDmAt = 0
        return
      }
      if (platform.isPaused()) return
      // 正常空闲保持配置的基础间隔；只有失败才指数退避。
      if (Date.now() - lastDmAt < pollDelay(L.dmIntervalSec ?? 60, dmFailures)) return
      lastDmAt = Date.now()
      dmBusy = true
      dmBusyAt = Date.now()
    dmBusyWarned = false
      try {
        const j = await platform.messages.pollOnce()
        if (!j.hit) { dmFailures = 0; return }
        if (stopped) return
        await delivery.send({
          requestId: `bili-whale-dm-${j.receipt}`,
          sessionId,
          mode: "queue",
          content: [{
            type: "text",
            text: workflows.dmPrompt(j),
          }],
        }, lifecycle.signal, {retainUntilAck:true})
        const ack = await platform.messages.ack(j.receipt)
        if (!ack.ok) throw new Error('私信已交付但确认失败：' + ack.err)
        await delivery.confirm(`bili-whale-dm-${j.receipt}`)
        dmFailures = 0
      } catch (e) {
        dmFailures++
        try { fs.appendFileSync(path.join(homeDir, ".bili-ai", "dm-tick-err.log"), new Date().toISOString() + " " + (e?.stack ?? e) + "\n") } catch {}
      }
      finally { dmBusy = false }
    }

  async function listenTick() {
    // A timeout is not proof of failed delivery. Keep single-flight ownership
    // until the existing operation settles; do not enqueue the same work again.
    if (listening) {
      if (!listeningWarned && Date.now() - listeningAt > 10 * 60_000) {
        listeningWarned = true
        log('[bili-whale] 评论监听等待超时：结果未确认，保留任务锁以避免重复投递；请检查宿主会话，勿直接重发')
      }
      return
    }
    if (stopped || listening) return
    if (!capabilities.comments?.read) { commentFailures = 0; lastListenAt = 0; return }
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch { cfg = {} }
    const L = cfg.listen ?? {}
    if (L.comment === false) {
      // 2026-10-24 修（和私信那个同一类坑）：关掉时把退避计数清零 ✓
      //   否则关一会儿再打开，第一次轮询还要按旧 commentFailures 等最多 15 分钟 ✗
      commentFailures = 0; lastListenAt = 0
      return
    }
    // 下限 60 秒（2026-10-18 测试期曾临时放宽到 2 秒 ✓ 已还原 ✓ —— B站 接口经不起每 2 秒锤 ✗）
    // 2026-10-24 修：窗口判断挪到「消耗间隔」【之前】✓
    //   以前是先 lastListenAt = now 再判断窗口 ✗
    //   → 窗口外白等一轮，窗口一开还得再等一整个退避间隔 ✗
    // 「全天」关掉时：只在她醒着的窗口里听（省 token / 更自然 ✓）
    if (!L.allDay && !inWindow(cfg)) {
      commentFailures = 0; lastListenAt = 0   // 窗口外不算失败 ✓ 也不占间隔 ✓
      return
    }
    if (platform.isPaused()) return
    const interval = pollDelay(L.commentIntervalSec ?? 60, commentFailures)
    if (Date.now() - lastListenAt < interval) return
    lastListenAt = Date.now()
    listening = true
    listeningAt = Date.now()
    listeningWarned = false
    try {
      const listenerState = readL() ?? {}
      const since = Number(listenerState.lastSeen ?? 0)
      const lastIds = new Set(listenerState.lastIds ?? [])
      const itemKey = x => `${x.kind}:${x.id}`
      const items = await platform.comments.pollComments({ scope: L.scope })
      // 第一次跑：只把"现在"当基线，不把历史回复全倒一遍 ✓
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); commentFailures = 0; return }
      const fresh = items.filter((x) => (Number(x.t) > since || (Number(x.t) === since && !lastIds.has(itemKey(x)))) && (!L.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? '')))
      if (!fresh.length) { commentFailures = 0; return }
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      if (stopped) return
      await delivery.send(
        {
          requestId: `bili-whale-listen-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{
            type: 'text',
            text: workflows.commentPrompt(cfg, fresh, who),
          }],
        },
        lifecycle.signal,
      )
      const lastSeen = Math.max(...fresh.map((x) => Number(x.t)))
      writeL({ lastSeen, lastIds: [...new Set([...(lastSeen === since ? lastIds : []), ...fresh.filter(x => Number(x.t) === lastSeen).map(itemKey)])] })
      commentFailures = 0
      log(`[bili-whale] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
    } catch (e) {
      commentFailures++
      log(`[bili-whale] 监听失败：${String(e.message).slice(0, 140)}`)
    } finally {
      listening = false
    }
  }

  // ── 直播间监听：起一个 `danmaku await` 子进程；它命中就退出（自带契约）→ 叫醒她 → 再挂上 ──
  // 为什么放独立循环：tick() 会在"今天 done"时提前 return ✗，直播间不能跟着停 ✓
  async function liveTick() {
    if (stopped) return
    if (!capabilities.liveChat?.read) {
      if (liveProc) { liveStopping = true; try { liveProc.kill() } catch {}; liveProc = null }
      return
    }
    if (platform.isPaused()) { if (liveProc) { liveStopping=true; try { liveProc.kill() } catch {} ;liveProc=null }; return }
    // ⚠️ 2026-10-18 主人定：直播间是**独立开关** —— 点开就开始、关掉就停（不受作息影响 ✓）
    if (host.canDeliver()) {
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
      if (!cur.listen?.live && liveProc !== null) {           // 开关被关掉 → 立刻停子进程 ✓
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log('[bili-whale] 直播间监听已停（开关关掉了 ✓）')
        return
      }
      // 2026-10-18 加：**换了房间号** → 也要立刻换线（以前只认开关 ✗ 换房间还在听老房间 ✗）
      const wantRoom = String(cur.listen?.liveRoom ?? '').trim()
      if (liveProc !== null && wantRoom && liveRoomNow && wantRoom !== liveRoomNow) {
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log(`[bili-whale] 直播间换房间：${liveRoomNow} → ${wantRoom}（立刻重挂 ✓）`)
        liveRoomNow = ''
        return
      }
    }
    if (liveProc !== null || liveWaking || liveRetryAt > Date.now()) return
    if (!host.canDeliver()) return
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
    const L = cfg.listen ?? {}
    const room = String(L.liveRoom ?? '').trim()
    if (!L.live || !room) return

    liveProc = platform.liveChat.start({
      room,
      scope: String(L.liveScope ?? 'owner'),
      operatorUid: String(L.liveScope ?? 'owner') === 'owner' && cfg.owner?.mid ? String(cfg.owner.mid) : undefined,
      onExit: (err, stdout, stderr) => {
      liveProc = null
      if (liveStopping) { liveStopping = false; return }   // 那是我们主动停的 ✓ 不算异常 ✗
      const out = String(stdout ?? '')
      // ⚠️ 2026-10-18 修真 bug：`danmaku-await` 命中时打印的是 **AWAIT_HIT** ✗
      //   我原来等的是 DANMAKU_HIT ✗ → 听见了也认不出 → 一直"退出/重挂"
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            if (stopped) return
            await delivery.send({
              requestId: `bili-whale-live-${Date.now()}`,
              sessionId,
              mode: 'queue',
              content: [{
                type: 'text',
                text: workflows.livePrompt(lines),
              }],
            }, lifecycle.signal)
            log(`[bili-whale] 直播间命中 → 已叫醒 · ${lines.slice(0, 80)}`)
          } catch (e) {
            log(`[bili-whale] 直播间叫醒失败：${String(e.message).slice(0, 120)}`)
          } finally {
            liveWaking = false
            // 2026-10-18 主人定：**监听到就回（实时）** ✓ —— 回复完 2 秒就重新挂上 ✗ 不再冷却 2 分钟
            liveRetryAt = Date.now() + 2_000
          }
        })()
      } else {
        // 退出但没命中 → 把"怎么退的"记全（2026-10-18：以前只记一句话，排不动 ✗）
        // 退避 12 秒（2026-10-18 改：原来 60 秒，外部误杀一次要等一分钟以上才回来 ✗）
        const tail = String(out ?? '').trim().split('\n').slice(-2).join(' | ').slice(-200)
        const why = [
          err ? `code=${err.code ?? '?'} signal=${err.signal ?? '?'}` : 'code=0',
          String(stderr ?? '').trim().slice(0, 150),
          tail,
        ].filter(Boolean).join(' · ')
        log(`[bili-whale] 直播间监听退出：${why}（12 秒后重挂）`)
        liveRetryAt = Date.now() + 12_000
      }
      },
    })
    if (!liveProc) return
    liveRoomNow = room   // 记下"现在听的是哪个房间" → 主人换房间时靠它检测 ✓
    log(`[bili-whale] 直播间监听已挂上（房间 ${room} · ${String(L.liveScope ?? 'owner') === 'owner' ? '只回主人' : '只回@她的'}）✓`)
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  const boot1 = setTimeout(() => { tick().catch(() => {}) }, 8000)          // 启动 8 秒后先跑一次
  // 30 秒看一眼"到点没"（2026-10-18 测试期曾改 2.5 秒 ✓ 已还原 ✓），真正间隔由配置定 ✓
  const timer2 = setInterval(() => { listenTick().catch(() => {}) }, 30_000)
  const boot2 = setTimeout(() => { listenTick().catch(() => {}) }, 15_000)
  const timerDm = setInterval(() => { dmTick().catch(() => {}) }, 20_000)   // 2026-10-19: 60s -> 20s, 私信要像聊天; 每次只是一个 get_sessions 请求 很轻
  const bootDm = setTimeout(() => { dmTick().catch(() => {}) }, 25_000)
  const timer3 = setInterval(() => { liveTick().catch(() => {}) }, 60_000)     // 直播间：挂了就一直跑，断了自动重挂 ✓
  const boot3 = setTimeout(() => { liveTick().catch(() => {}) }, 20_000)
  log(`[bili-whale] 自主生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId}）；监听 + 直播间监看都挂上了 ✓`)

  const listenerKeys = cfg => [
    JSON.stringify([cfg.listen?.dm, cfg.listen?.dmIntervalSec, cfg.owner?.mid]),
    JSON.stringify([cfg.listen?.comment, cfg.listen?.commentIntervalSec, cfg.listen?.allDay, cfg.listen?.scope, cfg.listen?.onlyOwner, cfg.owner?.mid, cfg.night?.windows]),
  ]
  let listenerConfig = listenerKeys(readCfgNow())
  return {
    /** Reload settings; only schedule changes invalidate the pending plan. */
    invalidate(resetPlan = true) {
      // Retain every dated window's completed/skip history, including across midnight.
      if (resetPlan) {
        if (waking) resetAfterDelivery = true
        else writeState(historyOf(readState() ?? {}))
      }
      const nextListenerConfig = listenerKeys(readCfgNow())
      if (nextListenerConfig[0] !== listenerConfig[0]) { dmFailures = 0; lastDmAt = 0 }
      if (nextListenerConfig[1] !== listenerConfig[1]) { commentFailures = 0; lastListenAt = 0 }
      listenerConfig = nextListenerConfig
      // 无关设置保存不重置轮询计时或失败退避。
      // Preserve the listener cursor: saving unrelated settings must not lose
      // messages that arrived since the previous successful delivery.
      tick().catch(() => {})
      listenTick().catch(() => {})
      dmTick().catch(() => {})
      // ⭐ 直播间是**单独开关**：保存设置就立刻生效（点开就跑 ✓ 关掉就停 ✓），不等下一轮定时器
      liveTick().catch(() => {})
    },
    // 2026-10-21 修（外部审计 #5）：原来漏了 timerDm —— 插件卸载/重载后那个 20 秒的私信轮询还在跑，
    //   重载几次就叠出几个杀不掉的旧轮询 ✗
    stop() { stopped = true; lifecycle.abort(); [boot1, boot2, bootDm, boot3].forEach(clearTimeout); clearInterval(timer); clearInterval(timer2); clearInterval(timer3); clearInterval(timerDm); try { liveProc?.kill() } catch {} },
    tick,
    listenTick,
    dmTick,
    liveTick,
  }
}
