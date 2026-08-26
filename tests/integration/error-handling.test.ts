/**
 * tests/integration/error-handling.test.ts
 *
 * Scenarios 4-9 — the network and HTTP-status paths of
 * `src/client/AnonVoteClient.ts`, none of which had ever executed in a test
 * before this suite existed. All [real].
 *
 * `withRetry` itself is already exhaustively unit-tested in
 * `tests/client.test.ts`; what is exercised here is retry *through the real
 * fetch path*, which is a different thing.
 */

import {
  setupFixture,
  teardownFixture,
  type IntegrationFixture,
} from "./setupFixture";
import { VoteLifecycleSimulator } from "./voteLifecycleSimulator";
import { HttpError } from "../../src/retry";
import {
  AuthError,
  BallotClosedError,
  BallotNotFoundError,
  InvalidTokenError,
  TimeoutError,
} from "../../src/client/errors";

describe("integration: error handling", () => {
  let fixture: IntegrationFixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    teardownFixture(fixture);
  });

  // Scenario 4 [real]
  it("retries a network-level rejection and succeeds on the second attempt", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 3 },
    });

    fixture.fetchMock.failNetwork(1);
    const ballot = await sim.createBallot();

    expect(ballot.id).toEqual(expect.any(String));
    // One failure + one success. Not three, not one.
    expect(fixture.fetchMock.callsTo("/ballots")).toHaveLength(2);
  });

  // Scenario 5 [real]
  it("retries a 500 to exhaustion and surfaces HttpError", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 2 },
    });

    fixture.fetchMock.forceStatus(99, 500, { message: "upstream exploded" });

    await expect(sim.createBallot()).rejects.toBeInstanceOf(HttpError);
    // maxRetries + 1 total attempts.
    expect(fixture.fetchMock.callsTo("/ballots")).toHaveLength(3);

    fixture.fetchMock.reset();
    fixture.fetchMock.forceStatus(99, 500);
    await expect(sim.createBallot()).rejects.toMatchObject({
      name: "HttpError",
      statusCode: 500,
    });
  });

  // Scenario 6 [real] — the AbortController timeout in fetchWithTimeout.
  it("aborts a slow request and raises TimeoutError", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      timeoutMs: 20,
      // maxRetries: 0 isolates the timeout mapping; a TimeoutError is not an
      // HttpError, so the default policy would retry it (see the amplification
      // test at the bottom of this file).
      retryConfig: { maxRetries: 0 },
    });

    fixture.fetchMock.setLatency(200);

    await expect(sim.createBallot()).rejects.toBeInstanceOf(TimeoutError);
    expect(fixture.fetchMock.callsTo("/ballots")).toHaveLength(1);
  });

  // Scenario 7 [real]
  it("maps 410 on a closed ballot to BallotClosedError", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 0 },
    });

    const ballot = await sim.createBallot();
    const tokens = await sim.issueTokens(2);

    // First vote lands while the ballot is open.
    await sim.castVotes([{ tokenIndex: 0, optionIndex: 0 }]);

    fixture.backend.closeBallot(ballot.id);

    await expect(
      sim.client.submitVote(ballot.id, tokens[1], ballot.options[0].id),
    ).rejects.toBeInstanceOf(BallotClosedError);

    // The rejected vote never reached the ledger.
    expect(fixture.ledger.countVotes(ballot.id)).toBe(1);
  });

  // Scenario 8 [real]
  it("maps 422 on an unrecognised token to InvalidTokenError", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 0 },
    });

    const ballot = await sim.createBallot();
    await sim.issueTokens(1);

    await expect(
      sim.client.submitVote(ballot.id, "d".repeat(64), ballot.options[0].id),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    expect(fixture.ledger.countVotes(ballot.id)).toBe(0);
  });

  // Scenario 9 [real]
  it("maps 401 on a write without a bearer token to AuthError", async () => {
    const unauthenticated = new VoteLifecycleSimulator(fixture, {
      authToken: "",
      retryConfig: { maxRetries: 0 },
    });

    await expect(unauthenticated.createBallot()).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(fixture.fetchMock.callsTo("/ballots")).toHaveLength(1);
  });

  it("maps 404 on an unknown ballot to BallotNotFoundError", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 0 },
    });

    await expect(
      sim.client.getBallotResults("00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(BallotNotFoundError);
  });

  /**
   * DOCUMENTATION TEST — pins a known defect, does not endorse it.
   *
   * `isRetryable` (src/retry.ts:109-115) returns `error instanceof Error` for
   * anything that is not an `HttpError`. `throwForStatus` maps 409/410/422 to
   * `InvalidTokenError`/`BallotClosedError`, which extend `AnonVoteError`, not
   * `HttpError` — so a permanently-failing domain error is retried
   * `maxRetries` times with backoff before it surfaces.
   *
   * A duplicate-token submission should cost exactly one request. It costs
   * four under the default policy. The assertion below records the *observed*
   * behaviour so a future fix is a deliberate, visible change to this test.
   *
   * Follow-up: `isRetryable` should treat AnonVoteError subclasses as
   * non-retryable (see the PR body for issue #79).
   */
  it("[known defect] retries a non-retryable 409 maxRetries+1 times", async () => {
    const sim = new VoteLifecycleSimulator(fixture, {
      retryConfig: { maxRetries: 3 },
    });

    const ballot = await sim.createBallot();
    const tokens = await sim.issueTokens(1);

    await sim.castVotes([{ tokenIndex: 0, optionIndex: 0 }]);
    fixture.fetchMock.reset();

    // Same token again -> 409 -> InvalidTokenError, which is permanent.
    await expect(
      sim.client.submitVote(ballot.id, tokens[0], ballot.options[0].id),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    // OBSERVED, not desired. Should be 1.
    expect(fixture.fetchMock.callsTo("/votes")).toHaveLength(4);

    // The amplification is wasted work only — the vote is still counted once.
    expect(fixture.ledger.countVotes(ballot.id)).toBe(1);
  });
});
