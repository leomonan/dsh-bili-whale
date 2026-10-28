# P1 Gate 1 — Session Transport Extraction

## Goal

Remove direct DSH controller API calls from the session-delivery state machine without changing delivery ordering, persistence, persona injection, acknowledgement, or rotation behavior.

## Contract

`lib/session-transport.js` defines the minimal transport shape:

- `ensureSession({ sessionId })`: prepare/reuse a host session.
- `deliver({ request, sessionId, content, signal })`: deliver content and preserve host cancellation semantics.

`lib/session-delivery.js` owns serialization, session state, persona fingerprinting, recovery instructions, pending request persistence, confirmation, and rotation. It no longer imports or calls DSH's `sessionController`.

`lib/dsh-session-transport.js` is the compatibility adapter. It maps `ensureSession` to `controller.create({ sessionId, cwd })` and `deliver` to `controller.prompt({ ...request, sessionId, content }, signal)`. This preserves the previous host call shape.

Paths for session state, persona, and diary recovery are injected by the scheduler instead of being resolved inside the delivery state machine. The scheduler still owns DSH-specific path selection.

## Preserved semantics

- All channels share one serialized delivery queue.
- Pending request IDs are persisted before a retained delivery is sent.
- Acknowledgement only clears the matching pending request.
- A failed delivery keeps its pending request and does not mark the boot delivery successful.
- A timeout is not interpreted as proof that delivery did not occur.
- Session rotation remains blocked by the existing age, cooldown, and busy checks.
- Persona and diary recovery text is unchanged for the DSH adapter.
- DSH behavior remains in the optional adapter; no Bilibili request or account operation is performed by this extraction.

## Verification

- `tests/session-delivery.test.mjs`: behavior characterization of state, ordering, acknowledgement, persona, and rotation.
- `tests/dsh-session-transport.test.mjs`: adapter mapping and fail-closed contract validation.
- Full CI must pass on this commit before Gate 1 is accepted.

## Remaining boundary

The scheduler is not yet host-neutral. It still owns DSH paths, Bilibili polling, and CLI subprocess calls. Next work must characterize the event-source boundary and separate the generic wake planner from platform polling, without rewriting the schedule state machine.
