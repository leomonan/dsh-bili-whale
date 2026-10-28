# P1 Gate 0 — DSH Host Decoupling Audit

Status: audit based on source at `agent-main@21920177d5fb923a0f78a442f7e2dc1eb8c0293a`.
Scope: identify the smallest behavior-preserving extraction boundary. No production behavior is changed in this Gate.

## Confirmed coupling

### 1. `lib/index.js` is a DSH host adapter, not core logic

It imports DSH-provided `ctx.sessionController`, `ctx.webServer`, and `ctx.connection`, registers `/dsh-bili/api/*` routes, mounts the DSH settings client, resolves DSH-specific runtime paths, and starts the scheduler inside `apply(ctx)`.

Target: keep these responsibilities in an optional `host-dsh` adapter. Do not import this module from the independent runtime.

### 2. `lib/scheduler.js` mixes scheduling with DSH delivery and Bilibili polling

It owns interval timers and persisted wake/listener state, but also imports `createSessionDelivery`, `ctx.sessionController` assumptions, DSH session paths/runtime resolution, Bilibili inbox helpers, and CLI subprocess execution.

Target: first extract only the wake/delivery seam behind an injected interface. Keep current scheduler decisions and persisted file formats unchanged until parity tests pass.

### 3. `lib/session-delivery.js` is the narrowest first seam

It currently accepts a `controller` and uses session-oriented delivery behavior, session IDs, and DSH-home state. Its queueing, persona acknowledgement, retained-until-ack and session rotation behavior is valuable, but should not be rewritten together with scheduling.

Target interface for the first extraction:

```js
/** A host-neutral task delivery contract. */
{
  deliver({ requestId, taskId, personaVersion, payload }, { signal })
  // returns { status: 'accepted' | 'already-accepted', receiptId }
  // host-specific acknowledgement semantics remain inside the adapter
}
```

This is a proposal, not yet a runtime contract. Before implementation, compare it line-by-line against the complete current `createSessionDelivery` behavior and tests. Do not lose pending request recovery or treat timeout as proof of non-delivery.

### 4. Bilibili polling and tool execution are separate concerns

The scheduler imports `pullFeed/makeHeaders`, `trafficGuard`, `pollDelay`, and starts `tools/bili.mjs` subprocesses for polling and actions. These must not be moved wholesale into the generic scheduler.

Target: platform events become injected sources; existing Bilibili implementation remains the first source adapter. CLI stays as compatibility surface until structured service functions are available and tested.

## Minimal P1 sequence

1. Inventory and run tests for `session-delivery`, `scheduler`, `night-plan`, listener polling and lifecycle cancellation.
2. Add contract tests for delivery acceptance, duplicate request IDs, retained-until-ack, cancellation, restart recovery, session rotation, and unknown outcomes.
3. Introduce the smallest injected delivery interface while preserving the current DSH implementation as the default adapter.
4. Add a fake delivery adapter test proving the scheduler can run without importing DSH session APIs.
5. Only after this gate passes, separate the daemon entrypoint and configuration/storage paths.
6. Keep all public Bilibili actions disabled in the new independent runtime until policy, idempotency and approval paths exist.

## Explicit non-goals for this gate

- No SQLite migration.
- No rewrite of the scheduler state machine.
- No change to wake timing, skip probability, quota, feedback decay, or public-action policy.
- No Bilibili network calls or account operations.
- No broad TypeScript conversion or monorepo split.
- No deleting legacy code or changing the DSH plugin's public behavior.

## Gate 0 acceptance

- [x] Read the host entrypoint, scheduler, session delivery, Bilibili traffic/API and config boundaries.
- [x] Identify the smallest plausible host-neutral seam.
- [x] Inventory exact existing tests and run the relevant test subset (full CI passed 160/160 before the adapter extraction).
- [x] Add behavior-characterization tests before changing delivery code.
- [ ] Independent reviewer verifies no state/ack semantics were omitted.

## P1 Gate 1 — delivery transport seam

The session-delivery state machine now depends on a host-neutral `SessionTransport` contract (`ensureSession`, `deliver`). The DSH mapping is isolated in `lib/dsh-session-transport.js`; scheduler configuration injects the same state, persona, and diary paths as before. Characterization tests cover queue ordering, persona injection, persisted pending requests, acknowledgements, and session rotation. The DSH adapter has separate mapping tests.

This is only a first seam: `lib/scheduler.js` still depends on DSH paths, Bilibili polling, and CLI subprocesses. Do not claim the whole runtime is host-independent until those boundaries are extracted and independently tested.

## P1 Gate 2 — inbox IO boundary

Bilibili comment/reply/mention reads and the network pause check are now encapsulated in `lib/bilibili-inbox-source.js`. The scheduler accepts an injected `inboxSource`; its cursor, first-run baseline, deduplication, polling interval, failure backoff and delivery rules remain in the scheduler. Unit tests cover `reply` versus combined scope and fail-closed credential/traffic-pause behavior. DM CLI polling, response/exit-code parsing, and receipt acknowledgement now live in `lib/bilibili-dm-source.js`; the scheduler retains the retry, delivery and acknowledgement state machine. Live-room subprocess construction now lives in `lib/bilibili-live-source.js`; the scheduler retains hit parsing, delivery, stop/restart, and retry decisions. The platform-specific IO is now composed by `lib/bilibili-runtime.js`; the scheduler consumes injected `inboxSource`, `dmSource`, and `liveSource` ports. The remaining DSH coupling is session/lifecycle/path ownership and scheduler-owned Bilibili workflow prompts.

Until all unchecked items pass, do not claim the core runtime is independent of DSH.


## P1 Gate 6 — scheduler host capability boundary

The generic scheduler now accepts a host capability object rather than a DSH context. Direct DSH session-controller checks, session-file discovery, session activity cache, and DSH transport construction moved to `lib/dsh-scheduler-host.js`. The plugin entrypoint and scheduler integration test helpers use the DSH compatibility entrypoint; the core scheduler sees only `transport`, `canDeliver()`, `isSessionBusy()`, and `setSessionId()`.

This removes direct DSH session-controller and session-file assumptions from `lib/scheduler.js`, but not all DSH path semantics. Config/state directory injection and workflow-prompt extraction remain follow-up gates. Do not claim the entire application is host-neutral yet.

## P1 Gate 7 — Bilibili wake workflow extraction

The Bilibili wake prompt and its feedback/daily-push context helpers now live in `lib/bilibili-workflows.js`, constructed with explicit config and home paths. The scheduler calls the workflow interface instead of owning the wake prompt text. This is an incremental extraction; comment, DM and live event prompt bodies are still inline in the scheduler and remain the next workflow extraction target.

## P1 Gate 8 — platform event workflow extraction

The Bilibili wake, skip, paused, DM, comment/mention and live-room prompt builders now live behind the Bilibili workflow object. The scheduler coordinates polling state and delivery but no longer embeds platform-specific instruction bodies. The DSH compatibility wrapper remains the only place that supplies the DSH host implementation.

## P1 Gate 9 — platform/runtime/path composition moved to host adapter

The core scheduler no longer imports the Bilibili runtime or the DSH night-config reader. It now requires explicit `stateDir`, `configFile`, `homeDir`, `readNightConfig`, `platformRuntime`, and `workflows` dependencies. The DSH compatibility entrypoint composes these dependencies and preserves the previous config-file override, legacy night-config merge, persona/diary paths, and Bilibili runtime defaults.

This gate makes the scheduler implementation host-agnostic at the dependency boundary; the current production adapter is still DSH+Bilibili. The next work is to formalize the platform event contract and add MCP/Skill/Daemon entrypoints.