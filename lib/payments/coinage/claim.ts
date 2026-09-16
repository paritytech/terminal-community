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
 *   2. The host then drives the claim on its own — waiting for the coins to
 *      reach the chain, re-submitting after a reorg, across an app restart if
 *      need be — and reports progress on `subscribeTopUpStatus(id)`:
 *      `detecting` → `claiming` → `claimed { finalized }` |
 *      `claimedPartially { actualClaimed }` | `notClaimed`.
 *   3. `claimed { finalized: false }` is the claim in a best-chain block —
 *      good enough to tell the merchant the payment is in, **not** the last
 *      word: a reorg can still turn it into `claimedPartially`. Only
 *      `claimed { finalized: true }`, `claimedPartially` and `notClaimed` are
 *      terminal. The terminal therefore resolves the sale at the first
 *      `claimed` and keeps following the registration in the background
 *      (./topup-watcher.ts) until one of the terminal statuses lands.
 *   4. `amount` is what the host compares the credited total against; a
 *      shortfall is `claimedPartially`, and the credited part is the
 *      merchant's money — a result, not a failure.
 *
 * Retrying is the host's job, not ours (its owner's words: "no extra
 * retry/recovery logic is needed on your side besides monitoring payment
 * status"). This module registers **once**; `notClaimed` surfaces as a
 * failure the merchant can answer with a manual retry, which registers again
 * under the next id. The one thing it does re-do on its own is re-subscribe
 * to the *same* registration when the host drops the status subscription.
 *
 * Before 0.11 the same call blocked until the host had claimed and reported
 * a shortfall as `PaymentTopUpErr::PartialPayment`. A 0.9.x client talking
 * to a ≥ 0.11 container sends a message without `id` that the container
 * cannot decode — and never answers. That silent hang is what this rewrite
 * fixed; see docs-internal/coinage-host-topup.md.
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

/** The statuses after which the host sends nothing more. */
export type FinalTopUpStatus = Extract<
  TopUpStatusEvent,
  { type: "claimedPartially" } | { type: "notClaimed" }
> | { type: "claimed"; finalized: true };

/** The statuses that settle a *sale*: the first `claimed` (any finality) or a final one. */
export type SettledTopUpStatus = Extract<
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
  /**
   * The host credited the full amount. `finalized` false means "in a
   * best-chain block" — keep following `topUpId` (./topup-watcher.ts).
   */
  | { kind: "claimed"; finalized: boolean; creditedPlanck: bigint; requestedPlanck: bigint; topUpId: Uint8Array }
  /** Only `creditedPlanck` of `requestedPlanck` arrived; terminal. */
  | { kind: "partial"; creditedPlanck: bigint; requestedPlanck: bigint; topUpId: Uint8Array };

export interface ClaimCoinsOptions {
  host: ClaimHost;
  /** The cheque amount in planck — what the host compares the credited total against. */
  amountPlanck: bigint;
  /** The coins' sr25519 secret keys, straight from the decrypted cheque. */
  keys: Uint8Array[];
  /** The 32-byte idempotency key for registration `attempt` (1-based, monotonic per sale). */
  topUpId: (attempt: number) => Uint8Array;
  /** Registration number to use — a manual retry passes the next one. */
  attempt?: number;
  /** How often to re-subscribe to this registration when the host drops the subscription. */
  maxResubscribes?: number;
  /** Pause before a re-subscribe. */
  backoffMs?: number;
  /** Aborting rejects with `ClaimCancelledError` and drops the status subscription. */
  signal?: AbortSignal;
  onStatus?: (status: TopUpStatusEvent) => void;
  onResubscribe?: (resubscribe: number, error: unknown) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_RESUBSCRIBES = 3;
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

/** Lowercase hex, no prefix — how a top-up id is stored on the sale record. */
export function topUpIdToHex(id: Uint8Array): string {
  let hex = "";
  for (const b of id) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function topUpIdFromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== TOP_UP_ID_BYTES * 2 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`top-up id must be ${TOP_UP_ID_BYTES} bytes of hex`);
  }
  const out = new Uint8Array(TOP_UP_ID_BYTES);
  for (let i = 0; i < TOP_UP_ID_BYTES; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
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

/** The host dropped the status subscription before a settling status. */
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

export function isFinalTopUpStatus(status: TopUpStatusEvent): status is FinalTopUpStatus {
  return (
    (status.type === "claimed" && status.finalized) ||
    status.type === "claimedPartially" ||
    status.type === "notClaimed"
  );
}

function settlesSale(status: TopUpStatusEvent): status is SettledTopUpStatus {
  return status.type === "claimed" || status.type === "claimedPartially" || status.type === "notClaimed";
}

/**
 * Follow registration `id` until `until(status)` is true. Rejects with
 * `ClaimCancelledError` on abort and `StatusInterruptedError` when the host
 * drops the subscription first.
 */
export function awaitTopUpStatus<T extends TopUpStatusEvent>(
  host: Pick<ClaimHost, "subscribeTopUpStatus">,
  id: Uint8Array,
  until: (status: TopUpStatusEvent) => status is T,
  signal?: AbortSignal,
  onStatus?: (status: TopUpStatusEvent) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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
      if (until(status)) finish(() => resolve(status));
    });
    subscription.onInterrupt?.((payload) =>
      finish(() => reject(new StatusInterruptedError(payload))),
    );
    // The host may have answered synchronously inside `subscribe`.
    if (done) subscription.unsubscribe();
  });
}

/** Follow `id` until the sale settles: the first `claimed`, or a final status. */
export function awaitSettledTopUpStatus(
  host: Pick<ClaimHost, "subscribeTopUpStatus">,
  id: Uint8Array,
  signal?: AbortSignal,
  onStatus?: (status: TopUpStatusEvent) => void,
): Promise<SettledTopUpStatus> {
  return awaitTopUpStatus(host, id, settlesSale, signal, onStatus);
}

/**
 * Register the claim (once) and follow it until the sale settles. When the
 * host drops the status subscription, re-register the *same* id — the host
 * answers `AlreadyExists` if it still knows it, or accepts it again if it
 * doesn't — and subscribe again, a bounded number of times.
 *
 * Resolves with what the host credited (see `ClaimOutcome`); throws
 * `NotClaimedError` when the host's last word is that nothing landed, the
 * registration error on `InvalidSource` or a failed registration, and
 * `ClaimCancelledError` on abort.
 */
export async function claimCoins(opts: ClaimCoinsOptions): Promise<ClaimOutcome> {
  const attempt = Math.max(1, opts.attempt ?? 1);
  const maxResubscribes = Math.max(0, opts.maxResubscribes ?? DEFAULT_MAX_RESUBSCRIBES);
  const backoffMs = opts.backoffMs ?? DEFAULT_CLAIM_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { amountPlanck, keys } = opts;
  const throwIfCancelled = () => {
    if (opts.signal?.aborted) throw new ClaimCancelledError();
  };

  let id = opts.topUpId(attempt);

  // 1. Register. AlreadyExists means this very registration is already known
  //    (a retry after a reload) — follow it. SourceBusy means an earlier
  //    registration of these coins is still live — follow that one instead.
  const register = async () => {
    try {
      await opts.host.topUp(amountPlanck, keys, id);
    } catch (error) {
      if (error instanceof PaymentTopUpErr.AlreadyExists) return;
      if (error instanceof PaymentTopUpErr.SourceBusy && attempt > 1) {
        id = opts.topUpId(attempt - 1);
        return;
      }
      throw error;
    }
  };

  throwIfCancelled();
  await register();

  // 2. Follow it until the sale settles; re-subscribe if the host drops us.
  for (let resubscribe = 0; ; resubscribe++) {
    let settled: SettledTopUpStatus;
    try {
      settled = await awaitSettledTopUpStatus(opts.host, id, opts.signal, opts.onStatus);
    } catch (error) {
      if (error instanceof ClaimCancelledError || resubscribe >= maxResubscribes) throw error;
      opts.onResubscribe?.(resubscribe + 1, error);
      await sleep(backoffMs);
      throwIfCancelled();
      await register();
      continue;
    }

    if (settled.type === "claimed") {
      return {
        kind: "claimed",
        finalized: settled.finalized,
        creditedPlanck: amountPlanck,
        requestedPlanck: amountPlanck,
        topUpId: id,
      };
    }
    if (settled.type === "claimedPartially") {
      if (settled.actualClaimed <= 0n) throw new NothingClaimedError();
      return { kind: "partial", creditedPlanck: settled.actualClaimed, requestedPlanck: amountPlanck, topUpId: id };
    }
    throw new NotClaimedError(attempt);
  }
}
