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

Until all unchecked items pass, do not claim the core runtime is independent of DSH.
