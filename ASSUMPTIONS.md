# ASSUMPTIONS

Documented assumptions made while implementing features in this repository, so
that a reviewer can override them deliberately rather than discovering them by
reading code.

---

## Issue #79 — Integration test suite with blockchain state simulation

_Recorded 2026-08-26._

### The simulated boundary

1. **This package has no backend and no Stellar code.** There is no
   `@stellar/stellar-sdk` dependency, no `submitTransaction`/`readTransaction`,
   and no ledger client anywhere in `src/`. The only Stellar presence is four
   inert `stellarTxId?: string` type fields and prose in the docs.
   `tests/integration/mockStellarNetwork.ts` therefore does **not** mock an
   existing integration — it simulates a boundary this package does not own.

   It exists because putting a simulated backend and ledger behind a mocked
   `fetch` is what makes the library's *own* untested code paths run end to end:
   `encryptVote`, `withRetry`, the `AbortController` timeout in
   `fetchWithTimeout`, and `throwForStatus`. Before this suite, nothing in the
   repo mocked `fetch`, so none of that network path had ever executed in a test.

2. **Every scenario is labelled `[real]` or `[harness]`** in the test files.
   `[real]` asserts on library behaviour; `[harness]` asserts on the simulator's
   own state machine. Of the 28 fast-tier tests, only three are purely
   `[harness]` (tally-snapshot consistency, results-before-tally, re-tally
   refusal). If that ratio drifts, the suite is drifting towards testing its own
   mocks.

3. **The mock backend holds the AES ballot key** so it can decrypt at tally
   time. A production backend must never hold it. Here it stands in for the
   trustee that performs the decryption, which is what lets scenario 18 assert
   on a genuine encrypt → store → decrypt round trip.

4. **The HTTP semantics of the mock backend are invented** — 401/404/409/410/422
   /500 are chosen to be realistic, but no real AnonVote API defines them yet.
   What the tests assert on is the library's *mapping* of those codes, which is
   real code in `throwForStatus`.

### Test mechanics

5. **Simulated latency uses real `setTimeout` at 0-5 ms, not fake timers.**
   Fake timers interact badly with the real `await`s inside `withRetry` and
   would serialise the very interleaving the concurrency scenarios exist to
   produce. Retry delays are neutralised by shrinking them (`FAST_RETRY`)
   rather than faking them.

6. **"Vote and tally race" is interpreted as tally-snapshot consistency.** The
   library exposes no locking primitive, so the assertable property is that the
   published totals are internally consistent and that post-close votes are
   rejected — not that a particular interleaving wins.

7. **One 128-bit Paillier keypair per test file**, built lazily in
   `setupFixture.sharedPaillierKeys()`. Key generation dominates the runtime
   budget. Production default is 2048 and must never be used in tests.

8. **The `fetch` mock races every response against the `AbortSignal`,** not just
   its artificial latency. Real `fetch` rejects the instant the signal fires,
   however deep the server is into handling the request; an earlier version of
   the mock only checked the signal around its own delay, which made a stalled
   backend silently untestable. The loser of the race has its rejection
   swallowed so an abandoned server-side promise cannot surface later as an
   unhandled rejection.

9. **A client-side timeout is not a rollback.** `MockBackend.submitVote`
   consumes the token synchronously before touching the ledger, and the
   compensating rollback sits after an `await`. If the ledger never settles, the
   token stays consumed even though no vote was anchored. This is deliberate and
   asserted: it mirrors the real hazard that a timed-out write may still land,
   and is the argument for making vote submission idempotent rather than
   at-most-once.

10. **No new runtime or dev dependencies.** No `nock`, no `msw` — the hand-rolled
   `fetch` mock in `setupFixture.ts` is about 60 lines and keeps this a
   zero-dependency package. Real `Response` objects (undici, Node 20+) are
   constructed so `res.ok`, `res.status` and `res.json()` behave as in
   production.

11. **`src/client/AnonVoteClient.ts` is imported by direct path.** It is not
   re-exported from either package entry point, so this is the only way to reach
   it. No public API was changed to make it testable.

### Known defects this suite pins but does not fix

Both are recorded as explicitly-named documentation tests asserting the
**observed** behaviour, so a future fix is a deliberate, visible change to the
test rather than a silent one.

12. **Retry amplification on domain errors.** `isRetryable`
    (`src/retry.ts:109-115`) returns `error instanceof Error` for anything that
    is not an `HttpError`. `throwForStatus` maps 409/410/422 to
    `InvalidTokenError`/`BallotClosedError`, which extend `AnonVoteError`, not
    `HttpError` — so a duplicate token costs four requests with backoff instead
    of one. Pinned by `[known defect] retries a non-retryable 409 …` in
    `tests/integration/error-handling.test.ts`.

13. **Only one of three clients gates voting by time.** `src/client/index.ts`
    enforces the election window; the root `src/client.ts` (`castVote`,
    lines 271-309) has no time or status check and will happily encrypt a vote
    for an election that closed a year ago. `BallotStatus` in `src/types.ts` is
    inert — never derived, never compared. Pinned by `[known gap] root client
    encrypts a vote for a long-expired election` in
    `tests/integration/ballot-state-machine.test.ts`.

    Fixing either means changing shipped public API behaviour, which does not
    belong in a testing change. Both are recommended follow-up issues.
