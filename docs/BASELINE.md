# P0 Baseline

- Upstream: https://github.com/Alterssss/dsh-bili-whale
- Fork: https://github.com/leomonan/dsh-bili-whale
- Fixed source baseline: `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`
- Baseline release: v0.4.6
- Development branch: `agent-main`
- Baseline scope: original DSH plugin and Bilibili CLI, unchanged by P0.

## Existing evidence (not a fresh run in GitHub Actions)

The previous implementation session reported `npm test` as 154 passing tests after switching to an environment that permits Node child processes. That report is historical evidence only; CI must independently execute the test suite on the remote branch.

## Required baseline checks

1. Record Node.js and npm versions.
2. Install dependencies from the repository's lock file if present. Do not upgrade dependencies.
3. Run `npm test` and preserve the process exit code and complete test summary.
4. Run `node --check` on JavaScript files where supported.
5. Confirm no secrets, cookies, personal diaries, or local runtime data are committed.
6. Confirm the working tree / remote commit is exactly the one under review.

## P0 acceptance

- [ ] Fork exists and upstream repository is unchanged.
- [ ] `agent-main` starts at the fixed baseline and contains only reviewed P0 files.
- [ ] Remote CI independently passes the existing tests.
- [ ] Development plan and baseline record are versioned.
- [ ] No DSH/Bilibili business behavior has been refactored in P0.

## Boundaries

No live Bilibili login, comments, messages, publishing, or account operations are part of P0. Do not report a check as passed unless it was actually executed and its result observed.
