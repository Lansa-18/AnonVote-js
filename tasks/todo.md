# Issue #79 — Integration test suite with blockchain state simulation

Branch: `feat/issue-79-integration-test-suite`

## Phase 1 — Infrastructure

- [x] `tests/integration/mockStellarNetwork.ts` — ledger simulator (submit/read tx, state, latency, failure injection)
- [x] `tests/integration/mockBackend.ts` — in-memory API over the ledger; token consumption, ballot state machine, status codes
- [x] `tests/integration/setupFixture.ts` — fetch mock install/restore, factories, shared lazy 128-bit Paillier keypair
- [x] `tests/integration/voteLifecycleSimulator.ts` — createBallot → issueTokens → castVotes → tallyVotes → verifyResult

## Post-implementation audit

Re-read `plan.md` against the shipped code. All 22 planned scenarios were
present, but the audit found the plan's file table under-delivered in one place:

- [x] **`mockStellarNetwork.readTransaction()` was dead code** — required by the
  plan's file table, called by no test. Now exercised in happy-path scenario 1
  (reads a vote back by txId, asserts the ledger holds the token *hash* not the
  raw token, and that an unknown txId returns null).
- [x] **Failure injection was dead code** — the plan required timeout /
  contract-error / tx-failed injection; none of the three ran. Now covered by
  three new tests in `error-handling.test.ts`.
- [x] `getSequence()`, `getStoredBallot()`, `callCount()` were also unreferenced;
  all now carry real assertions.
- [x] **Fidelity bug found by the new tests**: the `fetch` mock only honoured
  `AbortSignal` during its artificial latency, so an abort firing while the
  simulated backend was mid-handler never rejected — unlike real `fetch`. Fixed
  with a `withAbort()` race in `setupFixture.ts`. Without this, a stalled
  backend was silently untestable.

## Phase 2 — Scenarios (22 planned, 28 tests shipped)

- [x] `happy-path.test.ts` — 1-3
- [x] `error-handling.test.ts` — 4-9, plus a 404 mapping test, three ledger-failure tests, and the retry-amplification documentation test
- [x] `concurrency.test.ts` — 10-12
- [x] `ballot-state-machine.test.ts` — 13-17, plus the root-client time-gating documentation test
- [x] `encryption-pipeline.test.ts` — 18-22
- [x] `stress/vote-volume.test.ts` — opt-in tier (1200 AES votes, 50 homomorphic)

## Phase 3 — Wiring

- [x] `jest.config.js` — `testPathIgnorePatterns` for `tests/integration/`
- [x] `jest.integration.config.js`, `jest.stress.config.js`
- [x] `package.json` — `test:integration`, `test:integration:stress`
- [x] `.github/workflows/ci.yml` — named "Integration Tests" step between Test and Test Examples
- [x] `ASSUMPTIONS.md`

## Verification

Run on Node 24.16.0, 2026-08-26.

- [x] `npm run lint` — exit 0, no errors
- [x] `npm test` — 338 passing, 15 suites; identical to before, so integration is genuinely excluded
- [x] `npm run test:integration` — 28 passing, 5 suites, **0.59 s** (ceiling was 5 s)
- [x] `npm run test:integration:stress` — 2 passing, 0.50 s
- [x] `package.json` devDependencies duplicate keys left undisturbed, as the plan required
- [x] `npm run build` — clean; no integration files in `dist/`
- [x] Deliberately broken integration assertion → `test:integration` 1 failed / 24 passed, `npm test` still 338 passing

## Review

**What shipped.** Four infrastructure modules and six test files under
`tests/integration/` (28 fast-tier tests + 2 stress), plus two Jest configs, two
npm scripts, and one CI step. No `src/` change of any kind — the suite reaches
the previously-untestable HTTP client by direct path import rather than by
widening the public API.

**What it actually covers.** Before this, `tests/AnonVoteClient.test.ts` was a
one-assertion placeholder and nothing in the repo mocked `fetch`, so the whole
network path of `src/client/AnonVoteClient.ts` had never executed. It now does:
`encryptVote` on the way out, `withRetry` around real rejections and real 500s,
the `AbortController` timeout, and every branch of `throwForStatus`
(401/404/409/410/422/default).

**Runtime budget held comfortably.** The fast tier lands at 0.73 s against a 5 s
ceiling, so the homomorphic scenarios stayed in the fast tier rather than being
pushed to stress as the plan allowed for. One 128-bit Paillier keypair per file,
built lazily, is what keeps it there.

**Two defects pinned, neither fixed.** Both are `[known …]`-prefixed tests
asserting observed behaviour with a comment pointing at the follow-up:

1. Retry amplification — a duplicate token costs 4 requests instead of 1,
   because `isRetryable` treats every non-`HttpError` as transient and the
   domain errors from `throwForStatus` extend `AnonVoteError`.
2. Only `src/client/index.ts` gates voting by time; the root client encrypts
   votes for long-expired elections and `BallotStatus` is inert.

A third finding needs no test: `ApiError` (`src/client/errors.ts:55`) is never
constructed — `throwForStatus`'s default branch throws `HttpError`, contradicting
its own `@throws` tags.

Fixing any of these changes shipped public-API behaviour, which does not belong
in a testing change. All three are written up in `ASSUMPTIONS.md` and belong in
follow-up issues.
