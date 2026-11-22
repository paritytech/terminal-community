/**
 * What the terminal does with the statements on its payment topic, kept apart
 * from the React hook (./use-coinage-payment.ts) so it can be tested alone.
 *
 * Anyone who has seen the QR can post to the topic, and a cheque carries no
 * proof of who sent it. The terminal used to take the first cheque that
 * matched and drop everything that arrived while its claim ran, so a cheque
 * whose coins the host refuses cost the customer's cheque its turn for good.
 * Now every matching cheque is kept, and they are claimed one at a time:
 *
 *   - Never two claims that may both still credit. A claim is live at the
 *     host until the host says otherwise, whatever the terminal does: aborting
 *     only stops following it. Two live claims for one sale (a customer who
 *     scanned twice, or a slow customer cheque and a stranger's) could both
 *     land, and only one sale would be recorded.
 *   - So the next cheque goes only when the host's last word on the claim
 *     is that nothing was credited (notClaimed, nothing claimed, or the coins
 *     refused). Any other failure may still be live: that cheque blocks the
 *     rest, and only it runs again, on the merchant's Retry.
 *   - A cheque re-posted after its claim failed runs again, a bounded number
 *     of times; past that only the merchant's Retry runs it.
 *
 * A stranger's cheque whose coins never reach the chain still holds the sale
 * while the host waits for them (up to an hour). The terminal cannot tell it
 * from a customer's cheque whose coins are slow, so it does not move on by
 * itself. Once the claim has waited `stallMs`, the merchant may cancel. The
 * claim is then handed to the background, so it is still recorded if it
 * lands (./claim-handoff.ts).
 */

import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { decryptStatementData } from "./ecies";
import { normalizeAmount } from "./deeplink";
import { NotClaimedError, NothingClaimedError, TopUpRefusal } from "./claim";

export type ChequePayload = ReturnType<typeof decryptStatementData>["payload"];

/** Where the host is with one claim. */
export type ClaimStage = "registering" | "detecting" | "claiming";

/**
 * How long a claim may wait for its coins before the merchant may give up
 * on the sale. Longer than one host detection pass (30 s), so a customer's
 * cheque whose coins are on their way is not mistaken for a stuck one.
 */
export const CHEQUE_STALL_MS = 40_000;

/**
 * How many different cheques one sale keeps. An honest customer sends one;
 * the bound only stops a flood from growing memory. When it is reached,
 * cheques whose claims failed make room for new ones.
 */
export const MAX_CHEQUES_PER_SALE = 16;

/** How often a re-posted cheque may start its failed claim again on its own. */
export const MAX_REPOST_RUNS = 2;

export type SkipReason = "empty" | "decrypt_failed" | "id_mismatch" | "amount_mismatch";

export type StatementMatch =
  | { ok: true; cheque: ChequePayload; key: string }
  /** `detail` is the log line saying why, with every stranger-supplied value quoted and cut short. */
  | { ok: false; reason: SkipReason; detail: string };

/**
 * Open one statement and check it is a cheque for this very request. Never
 * throws: whatever a stranger posts on the topic, the subscription survives.
 */
export function matchStatement(
  privateKey: Uint8Array,
  data: Uint8Array | null | undefined,
  paymentId: string,
  expectedAmount: string,
): StatementMatch {
  if (!data || data.length === 0) return { ok: false, reason: "empty", detail: "statement has no data — skip" };

  let cheque: ChequePayload;
  try {
    ({ payload: cheque } = decryptStatementData(privateKey, data));
  } catch (err) {
    return { ok: false, reason: "decrypt_failed", detail: `decrypt failed (len=${data.length}): ${errorText(err)}` };
  }

  if (cheque.id !== paymentId) {
    return { ok: false, reason: "id_mismatch", detail: `id mismatch: got ${safeForLog(cheque.id)}, want "${paymentId}" — skip` };
  }
  if (!amountsMatch(cheque.amount, expectedAmount)) {
    return {
      ok: false,
      reason: "amount_mismatch",
      detail: `amount mismatch: got ${safeForLog(cheque.amount)}, want "${expectedAmount}" — skip`,
    };
  }
  return { ok: true, cheque, key: chequeKey(cheque) };
}

/**
 * True when the cheque asks for exactly the amount on the QR. An amount the
 * terminal could never have asked for (above the cheque limit, say) is a
 * mismatch, not an error.
 */
export function amountsMatch(chequeAmount: string, expectedAmount: string): boolean {
  try {
    return normalizeAmount(chequeAmount) === expectedAmount;
  } catch {
    return false;
  }
}

/**
 * Identifies a cheque by its coins, so a re-post of the same cheque (the
 * same coins under a fresh envelope) is recognised as the same one. Hashed,
 * so the coin secrets themselves are not kept as map keys.
 */
export function chequeKey(cheque: Pick<ChequePayload, "coins">): string {
  const length = cheque.coins.reduce((n, c) => n + 4 + c.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const coin of cheque.coins) {
    // Length-prefixed, so [ab, c] and [a, bc] differ.
    new DataView(bytes.buffer).setUint32(offset, coin.length);
    bytes.set(coin, offset + 4);
    offset += 4 + coin.length;
  }
  let hex = "";
  for (const b of blake2b256(bytes)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A value from a stranger's statement, made safe to put in a log line: quoted,
 * no control characters (so no forged extra lines), and short.
 */
export function safeForLog(value: unknown, max = 48): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  const cut = text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
  return JSON.stringify(cut);
}

function errorText(err: unknown): string {
  return safeForLog(err instanceof Error ? err.message : String(err), 120).slice(1, -1);
}

/**
 * True when the host's answer means this cheque's coins credited nothing and
 * registering them again would not change that by itself.
 */
export function creditedNothing(err: unknown): boolean {
  if (err instanceof NotClaimedError || err instanceof NothingClaimedError) return true;
  return err instanceof TopUpRefusal && (err.kind === "InvalidSource" || err.kind === "InsufficientFunds");
}

/** How one cheque stands in the book. */
export type ChequeState =
  /** Arrived, never claimed. */
  | "new"
  /** A claim of it is running. */
  | "running"
  /** Its last claim failed. */
  | "failed"
  /** Failed, and asked for again (re-posted, or the merchant's Retry). */
  | "again";

export interface ChequeEntry {
  readonly key: string;
  readonly cheque: ChequePayload;
  state: ChequeState;
  /** The registration attempt its last claim started under. */
  lastAttempt: number | null;
  /**
   * Its registrations the host may still credit: accepted (or possibly
   * accepted) and never given a last word. While any is left, no other
   * cheque runs.
   */
  live: Set<number>;
  /** Its most recent registration the host accepted: the one to follow on SourceBusy. */
  lastAccepted: number | null;
  /** When its running claim started. */
  startedAt: number | null;
  stage: ClaimStage | null;
  /** Its last claim ended with the host's word that nothing was credited. */
  creditedNothing: boolean;
  /** How many claims of it have started. */
  runs: number;
  /** How many of those a re-post started. */
  repostRuns: number;
}

export type OfferResult =
  /** A cheque not seen before for this sale. */
  | "new"
  /** A cheque whose last claim failed, asked for again. */
  | "again"
  /** Already being claimed, or already waiting its turn. */
  | "duplicate"
  /** Failed, and re-posted too often to run again on its own. */
  | "exhausted"
  /** The book is full of cheques still in play; the cheque is dropped. */
  | "full";

export interface NextStep {
  /** The cheque to claim now, or null. */
  entry: ChequeEntry | null;
  /** When to ask again, because a running claim will have stalled by then. */
  wakeInMs: number | null;
}

const STAGE_RANK: Record<ClaimStage, number> = { registering: 0, detecting: 1, claiming: 2 };

/** The cheques one sale has received, and which to claim next. */
export class ChequeBook {
  private readonly entries: ChequeEntry[] = [];
  private readonly capacity: number;
  private readonly stallMs: number;
  private readonly now: () => number;

  constructor(opts: { capacity?: number; stallMs?: number; now?: () => number } = {}) {
    this.capacity = opts.capacity ?? MAX_CHEQUES_PER_SALE;
    this.stallMs = opts.stallMs ?? CHEQUE_STALL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  offer(cheque: ChequePayload, key: string): OfferResult {
    const known = this.entries.find((e) => e.key === key);
    if (known) {
      if (known.state !== "failed") return "duplicate";
      if (known.repostRuns >= MAX_REPOST_RUNS) return "exhausted";
      known.state = "again";
      known.repostRuns += 1;
      return "again";
    }
    if (this.entries.length >= this.capacity && !this.evictFailed()) return "full";
    this.entries.push({
      key,
      cheque,
      state: "new",
      lastAttempt: null,
      startedAt: null,
      stage: null,
      creditedNothing: false,
      live: new Set(),
      lastAccepted: null,
      runs: 0,
      repostRuns: 0,
    });
    return "new";
  }

  /**
   * Make room by forgetting a failed cheque none of whose registrations the
   * host may still credit. Never one that may: it is what holds the rest back.
   */
  private evictFailed(): boolean {
    const victim = this.entries.find((e) => e.state === "failed" && !this.mayBeLive(e));
    if (!victim) return false;
    this.entries.splice(this.entries.indexOf(victim), 1);
    return true;
  }

  /** Still waiting for its coins, past `stallMs`. */
  private isStalled(e: ChequeEntry, now: number): boolean {
    return e.stage === "detecting" && now - (e.startedAt ?? now) >= this.stallMs;
  }

  /**
   * The cheque to claim now, if any. Nothing starts while a claim runs; its
   * `wakeInMs` is when it will count as stalled. While a failed claim may
   * still be live at the host, only that cheque may run, and only when asked
   * for again. Otherwise new cheques go before ones asked for again.
   */
  next(): NextStep {
    const now = this.now();
    const running = this.running();
    if (running.length > 0) {
      const waits = running
        .filter((e) => e.stage === "detecting" && !this.isStalled(e, now))
        .map((e) => (e.startedAt ?? now) + this.stallMs - now);
      return { entry: null, wakeInMs: waits.length > 0 ? Math.max(0, Math.min(...waits)) : null };
    }
    const mayBeLive = this.entries.filter((e) => this.mayBeLive(e));
    if (mayBeLive.length > 0) {
      return { entry: mayBeLive.find((e) => e.state === "again") ?? null, wakeInMs: null };
    }
    const entry =
      this.entries.find((e) => e.state === "new") ??
      this.entries.find((e) => e.state === "again") ??
      null;
    return { entry, wakeInMs: null };
  }

  /** Not running, with a registration the host may still credit. */
  private mayBeLive(e: ChequeEntry): boolean {
    return (e.state === "failed" || e.state === "again") && e.live.size > 0;
  }

  /** True when no claim runs and a failed one may still be live: new cheques wait for Retry. */
  blockedByLiveFailure(): boolean {
    return this.running().length === 0 && this.entries.some((e) => e.state === "failed" && this.mayBeLive(e));
  }

  /**
   * Mark `entry` running under registration `attempt`. Returns the
   * registration of its coins to follow should the host answer SourceBusy:
   * the last one the host accepted, or null.
   */
  start(entry: ChequeEntry, attempt: number): number | null {
    const previous = entry.lastAccepted;
    entry.state = "running";
    entry.lastAttempt = attempt;
    entry.startedAt = this.now();
    entry.stage = "registering";
    entry.runs += 1;
    return previous;
  }

  /**
   * The host's progress on a running claim. Its stall clock starts when the
   * host has accepted it and is waiting for coins.
   */
  setStage(entry: ChequeEntry, stage: ClaimStage): void {
    if (entry.state !== "running") return;
    if (stage === "detecting" && entry.stage !== "detecting") entry.startedAt = this.now();
    entry.stage = stage;
  }

  /** The host accepted registration `attempt` for this cheque, and the claim follows it. */
  accepted(entry: ChequeEntry, attempt: number): void {
    entry.live.add(attempt);
    entry.lastAccepted = attempt;
  }

  /**
   * The claim failed. `followed` is the registration it was following (null
   * when the host never accepted one). `settled` is whether the host's last
   * word on that registration is that nothing was credited; only then does it
   * stop counting as live. A failure before any acceptance that was not the
   * host's own refusal (a dropped bridge call, say) may have registered
   * `attempt` all the same.
   */
  fail(
    entry: ChequeEntry,
    outcome: { attempt: number; followed: number | null; settled: boolean; refusedByHost: boolean },
  ): void {
    entry.state = "failed";
    entry.startedAt = null;
    entry.stage = null;
    entry.creditedNothing = outcome.settled;
    if (outcome.followed != null) {
      if (outcome.settled) entry.live.delete(outcome.followed);
    } else if (!outcome.refusedByHost) {
      entry.live.add(outcome.attempt);
      entry.lastAccepted = outcome.attempt;
    }
  }

  /** Cheques whose last claim failed and that have not been asked for again. */
  failedCount(): number {
    return this.entries.filter((e) => e.state === "failed").length;
  }

  /** The merchant's Retry: every failed cheque may run again. Returns how many. */
  retryFailed(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.state === "failed") {
        e.state = "again";
        n++;
      }
    }
    return n;
  }

  running(): ChequeEntry[] {
    return this.entries.filter((e) => e.state === "running");
  }

  /** The running claim the screen follows (there is at most one). */
  leader(): ChequeEntry | null {
    let best: ChequeEntry | null = null;
    for (const e of this.running()) {
      if (!best || STAGE_RANK[e.stage ?? "registering"] > STAGE_RANK[best.stage ?? "registering"]) best = e;
    }
    return best;
  }

  /**
   * True when a claim is running and still waiting for its coins past
   * `stallMs`: the payment may never come from it.
   */
  stalled(): boolean {
    const running = this.running();
    if (running.length === 0) return false;
    const now = this.now();
    return running.every((e) => this.isStalled(e, now));
  }

  get size(): number {
    return this.entries.length;
  }
}
