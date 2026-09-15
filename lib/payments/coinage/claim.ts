/**
 * Claiming the coins of a W3S cheque through the host — `paymentTopUp(Coins)`.
 *
 * The contract, as of host-api 0.11+ (the Polkadot apps built from
 * September 2026 on — the 2026-09-14 Android build on the test device ships a
 * container with exactly the 0.12.0 method set):
 *
 *   1. `topUp(amount, source, id)` only *registers* the top-up and resolves as
 *      soon as the host has accepted it. `id` is a 32-byte idempotency key we
 *      choose; the same id twice answers `AlreadyExists`, and a source whose
 *      previous top-up has not reached a terminal status answers `SourceBusy`.
 *   2. The host then drives the claim on its own — across an app restart if
 *      need be — and reports progress on `subscribeTopUpStatus(id)`:
 *      `detecting` (coins not on chain yet) → `claiming` → `claimed` (in a
 *      block; `finalized` follows) | `claimedPartially { actualClaimed }` |
 *      `notClaimed`. The last three are terminal.
 *   3. `amount` is what the host compares the credited total against. A
 *      shortfall is `claimedPartially`, and the credited part is the
 *      merchant's money — a result, not a failure.
 *
 * `notClaimed` is the host's last word for *that registration* ("never saw a
 * balance at the source"), not for the coins: a payer whose offboard was slow
 * has the coins on chain a little later, so the terminal re-registers with a
 * fresh id a few times before giving up, and offers a manual retry after that.
 *
 * Before 0.11 the same call blocked until the host had claimed (bounded at
 * ~60 s from the "durability" rework on) and reported a shortfall as
 * `PaymentTopUpErr::PartialPayment`. A 0.9.x client talking to a ≥ 0.11
 * container sends a message without `id` that the container cannot decode —
 * and never answers. That silent hang is what this rewrite fixes; see
 * docs-internal/coinage-host-topup.md.
 */

import { PaymentTopUpErr } from "@novasamatech/host-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";

/** One progress report from `subscribeTopUpStatus`, in the wrapper's shape. */
export type TopUpStatusEvent =
  | { type: "detecting" }
  | { type: "claiming" }
  | { type: "claimed"; finalized: boolean }
  | { type: "claimedPartially"; actualClaimed: bigint }
  | { type: "notClaimed" };

export type TerminalTopUpStatus = Extract<
  TopUpStatusEvent,
  { type: "claimed" } | { type: "claimedPartially" } | { type: "notClaimed" }
>;

export interface TopUpStatusSubscription {
  unsubscribe: () => void;
  /** The host dropped the subscription (e.g. `PaymentTopUpStatusErr::NotFound`). */
  onInterrupt?: (callback: (payload: unknown) => void) => unknown;
}

/** The two host calls a claim needs — the wrapper's payment manager, or a fake in tests. */
export interface ClaimHost {
  topUp: (amountPlanck: bigint, keys: Uint8Array[], id: Uint8Array) => Promise<void>;
  subscribeTopUpStatus: (
    id: Uint8Array,
    onStatus: (status: TopUpStatusEvent) => void,
  ) => TopUpStatusSubscription;
}

export type ClaimOutcome =
  /** Every coin landed; the host credited the full amount. */
  | { kind: "claimed"; creditedPlanck: bigint; requestedPlanck: bigint; topUpId: Uint8Array }
  /** Only `creditedPlanck` of `requestedPlanck` arrived; the host will not claim more. */
  | { kind: "partial"; creditedPlanck: bigint; requestedPlanck: bigint; topUpId: Uint8Array };

export interface ClaimCoinsOptions {
  host: ClaimHost;
  /** The cheque amount in planck — what the host compares the credited total against. */
  amountPlanck: bigint;
  /** The coins' sr25519 secret keys, straight from the decrypted cheque. */
  keys: Uint8Array[];
  /** The 32-byte idempotency key for registration `attempt` (1-based, monotonic per sale). */
  topUpId: (attempt: number) => Uint8Array;
  /** Registration number to start from — a manual retry continues the sequence. */
  firstAttempt?: number;
  /** How many registrations to make before giving up on `notClaimed`. */
  maxAttempts?: number;
  /** Pause between registrations — gives the payer's coins time to reach the chain. */
  backoffMs?: number;
  /** Aborting rejects with `ClaimCancelledError` and drops the status subscription. */
  signal?: AbortSignal;
  /** `attemptIndex` counts from 1 within this call; `attempt` is the absolute registration number. */
  onAttempt?: (attemptIndex: number, maxAttempts: number, attempt: number) => void;
  onStatus?: (status: TopUpStatusEvent, attempt: number) => void;
  onRetryableFailure?: (attempt: number, error: unknown) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CLAIM_ATTEMPTS = 3;
export const DEFAULT_CLAIM_BACKOFF_MS = 4_000;
export const TOP_UP_ID_BYTES = 32;

const TOP_UP_ID_PREFIX = "pay-w3s-topup:";

/**
 * The idempotency key for registration `attempt` of `paymentId`'s claim:
 * blake2b256("pay-w3s-topup:<paymentId>:<attempt>"). Deterministic, so a
 * retry after a reload or a `SourceBusy` can find the registration it made.
 */
export function deriveTopUpId(paymentId: string, attempt: number): Uint8Array {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`top-up attempt must be a positive integer (got ${attempt})`);
  }
  const id = blake2b256(new TextEncoder().encode(`${TOP_UP_ID_PREFIX}${paymentId}:${attempt}`));
  if (id.length !== TOP_UP_ID_BYTES) {
    throw new Error(`top-up id must be ${TOP_UP_ID_BYTES} bytes (got ${id.length})`);
  }
  return id;
}

/** Thrown when the claim is stopped because the sale ended. */
export class ClaimCancelledError extends Error {
  override readonly name = "ClaimCancelledError";
  constructor() {
    super("claim cancelled");
  }
}

/** The host's last word for a registration: nothing landed. */
export class NotClaimedError extends Error {
  override readonly name = "NotClaimedError";
  constructor(readonly attempt: number) {
    super(`no coins were claimed (registration ${attempt})`);
  }
}

/** The host reported a partial claim that credited nothing at all. */
export class NothingClaimedError extends Error {
  override readonly name = "NothingClaimedError";
  constructor() {
    super("no coins were claimed");
  }
}

/** The host dropped the status subscription before a terminal status. */
export class StatusInterruptedError extends Error {
  override readonly name = "StatusInterruptedError";
  constructor(readonly payload: unknown) {
    super(`top-up status subscription interrupted: ${describePayload(payload)}`);
  }
}

function describePayload(payload: unknown): string {
  if (payload instanceof Error) return payload.name || payload.message;
  if (payload && typeof payload === "object") {
    const o = payload as { tag?: unknown; name?: unknown };
    if (typeof o.tag === "string") return o.tag;
    if (typeof o.name === "string") return o.name;
  }
  return String(payload ?? "unknown");
}

/**
 * Whether registering again can change the answer. `InvalidSource` is the
 * host telling us the keys themselves are unusable; everything else — a
 * dropped bridge call, an `Unknown` — may pass on the next try.
 */
export function isRetryableTopUpError(error: unknown): boolean {
  if (error instanceof PaymentTopUpErr.InvalidSource) return false;
  if (error instanceof ClaimCancelledError) return false;
  return true;
}

function isTerminal(status: TopUpStatusEvent): status is TerminalTopUpStatus {
  return status.type === "claimed" || status.type === "claimedPartially" || status.type === "notClaimed";
}

/**
 * Follow registration `id` until the host reports a terminal status.
 * Rejects with `ClaimCancelledError` on abort and `StatusInterruptedError`
 * when the host drops the subscription first.
 */
export function awaitTerminalTopUpStatus(
  host: ClaimHost,
  id: Uint8Array,
  signal?: AbortSignal,
  onStatus?: (status: TopUpStatusEvent) => void,
): Promise<TerminalTopUpStatus> {
  return new Promise<TerminalTopUpStatus>((resolve, reject) => {
    let done = false;
    let subscription: TopUpStatusSubscription | null = null;

    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      subscription?.unsubscribe();
      settle();
    };
    const onAbort = () => finish(() => reject(new ClaimCancelledError()));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    subscription = host.subscribeTopUpStatus(id, (status) => {
      if (done) return;
      onStatus?.(status);
      if (isTerminal(status)) finish(() => resolve(status));
    });
    subscription.onInterrupt?.((payload) =>
      finish(() => reject(new StatusInterruptedError(payload))),
    );
    // The host may have answered synchronously inside `subscribe`.
    if (done) subscription.unsubscribe();
  });
}

/**
 * Register the claim and follow it to its terminal status, re-registering
 * with a fresh id while the host reports `notClaimed` or loses the
 * subscription. Resolves with what the host credited; throws the last error
 * once the attempts are used up, on `InvalidSource`, or on abort.
 */
export async function claimCoinsWithRetry(opts: ClaimCoinsOptions): Promise<ClaimOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_CLAIM_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_CLAIM_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const first = Math.max(1, opts.firstAttempt ?? 1);
  const last = first + maxAttempts - 1;
  const { amountPlanck, keys } = opts;

  const throwIfCancelled = () => {
    if (opts.signal?.aborted) throw new ClaimCancelledError();
  };
  const backoff = async (attempt: number, error: unknown) => {
    opts.onRetryableFailure?.(attempt, error);
    await sleep(backoffMs);
    throwIfCancelled();
  };

  let lastError: unknown = new Error("claim not attempted");
  for (let attempt = first; attempt <= last; attempt++) {
    throwIfCancelled();
    opts.onAttempt?.(attempt - first + 1, maxAttempts, attempt);
    let id = opts.topUpId(attempt);

    // 1. Register. AlreadyExists means this very registration is already
    //    known (a retry after a reload) — follow it. SourceBusy means an
    //    earlier registration of these coins is still live — follow that one.
    try {
      await opts.host.topUp(amountPlanck, keys, id);
    } catch (error) {
      if (error instanceof PaymentTopUpErr.AlreadyExists) {
        // fall through to the status subscription
      } else if (error instanceof PaymentTopUpErr.SourceBusy && attempt > 1) {
        id = opts.topUpId(attempt - 1);
      } else {
        lastError = error;
        if (!isRetryableTopUpError(error) || attempt === last) throw error;
        await backoff(attempt, error);
        continue;
      }
    }

    // 2. Follow it to a terminal status.
    let terminal: TerminalTopUpStatus;
    try {
      terminal = await awaitTerminalTopUpStatus(opts.host, id, opts.signal, (status) =>
        opts.onStatus?.(status, attempt),
      );
    } catch (error) {
      if (error instanceof ClaimCancelledError) throw error;
      lastError = error;
      if (attempt === last) throw error;
      await backoff(attempt, error);
      continue;
    }

    if (terminal.type === "claimed") {
      return { kind: "claimed", creditedPlanck: amountPlanck, requestedPlanck: amountPlanck, topUpId: id };
    }
    if (terminal.type === "claimedPartially" && terminal.actualClaimed > 0n) {
      return {
        kind: "partial",
        creditedPlanck: terminal.actualClaimed,
        requestedPlanck: amountPlanck,
        topUpId: id,
      };
    }

    // notClaimed (or a partial that credited nothing): the host's last word
    // for this registration. Give the payer's coins a moment and register again.
    lastError = terminal.type === "claimedPartially" ? new NothingClaimedError() : new NotClaimedError(attempt);
    if (attempt === last) throw lastError;
    await backoff(attempt, lastError);
  }
  throw lastError;
}
