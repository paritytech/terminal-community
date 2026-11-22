/**
 * W3S Coinage payment — terminal side (Appendix F of "Merchant Payments W3S -
 * Host & Terminal").
 *
 * Per active sale this hook:
 *   1. mints a fresh ephemeral X25519 keypair + payment id,
 *   2. derives topic = blake2b256("pay-w3s:" || id) and exposes the
 *      `polkadotapp://pay/cheque` deeplink as `qrValue`,
 *   3. subscribes to the statement store on that topic,
 *   4. on a matching statement: decrypts the "cheque" envelope (ECIES),
 *      validates id + amount (./cheque-intake.ts, which also decides which
 *      cheque to claim when more than one arrives), then claims the bearer
 *      coins into the merchant
 *      coin set through the host: `paymentTopUp(Coins)` registers the claim
 *      under a 32-byte id and `subscribeTopUpStatus(id)` follows it until
 *      the sale settles (first `claimed`, or a partial credit — a result,
 *      not a failure). Finality is followed afterwards, in the background,
 *      by ./topup-watcher.ts. The contract with the host is in ./claim.ts.
 *
 * The terminal itself does no on-chain work — the host moves the coins.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClaimHost, subscribeHostStatements, type HostStatementsPage } from "@/lib/host/payments";

import { detectHostEnvironment } from "@/lib/host";
import { recordCoinagePaymentPhase } from "@/lib/telemetry";
import { amountToPlanck, formatAmountFromPlanck } from "@/lib/utils/format";
import { PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { generateEphemeralKeypair, generatePaymentId } from "./keys";
import { deriveTopic } from "./topic";
import { buildPayW3sDeeplink, normalizeAmount } from "./deeplink";
import { withSpan, captureWarning } from "@/lib/telemetry";
import { classifyTopupError, describeTopupFailure, type TopupErrorKind } from "./topup-error";
import {
  claimCoins,
  deriveTopUpId,
  topUpIdToHex,
  type TopUpStatusEvent,
} from "./claim";
import { markClaimInSession } from "./pending-claims";
import { TopUpRefusal } from "./claim";
import { handOffClaim } from "./claim-handoff";
import {
  ChequeBook,
  creditedNothing,
  matchStatement,
  MAX_CHEQUES_PER_SALE,
  type ChequeEntry,
  type ClaimStage,
  type SkipReason,
} from "./cheque-intake";

export type { ClaimStage } from "./cheque-intake";

/** Skipped statements logged in full per reason and sale; the rest are counted. */
const SKIP_LOG_LIMIT = 5;
/** Statement pages logged per sale before only every 100th is. */
const PAGE_LOG_LIMIT = 20;
/**
 * Registrations one sale makes on its own. Past this only the merchant's
 * Retry registers, so a stream of cheques the host refuses cannot drive
 * registrations (and their pending-claim ids and telemetry) without end.
 */
const MAX_AUTO_REGISTRATIONS = 12;

function log(message: string): void {
  // Trace the full coinage detection flow in the host devtools console.
  console.log(`[coinage] ${message}`);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Host errors come back in several shapes: a JS `Error` (the `PaymentTopUpErr`
 * variants are Error subclasses carrying `payload`/`value`), a SCALE
 * `CodecError`, or a plain `{ tag, value: { reason } }`. The naive `.message`
 * hides the real cause for the structured ones — so dig out whatever's there.
 * This is the raw detail for the console and telemetry; the merchant sees
 * `describeTopupFailure` instead.
 */
function describeError(err: unknown): string {
  if (err == null) return "null/undefined error";
  if (err instanceof Error) {
    const o = err as Error & { payload?: { reason?: unknown }; value?: { reason?: unknown } };
    const reason = o.payload?.reason ?? o.value?.reason;
    const head = err.message || err.name;
    return typeof reason === "string" && reason && !head.includes(reason) ? `${head}: ${reason}` : head;
  }
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const tag = typeof o.tag === "string" ? o.tag : undefined;
    const value = o.value as Record<string, unknown> | undefined;
    const reason =
      (value && typeof value.reason === "string" && value.reason) ||
      (typeof o.reason === "string" && o.reason) ||
      (typeof o.message === "string" && o.message) ||
      undefined;
    if (tag || reason) return `${tag ?? "Error"}${reason ? `: ${reason}` : ""}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export type CoinageStatus =
  | "idle"
  | "preparing"
  | "waiting"
  | "claiming"
  | "paid"
  | "error";

export interface CoinagePaymentResult {
  /** The payment id minted for this sale. */
  paymentId: string;
  /** Decimal amount (2dp) the host actually credited — what to record as the sale. */
  amount: string;
  /** Decimal amount (2dp) the cheque asked for; differs from `amount` on a partial claim. */
  requestedAmount: string;
  /** True when the host credited less than requested and will claim no more. */
  partial: boolean;
  /**
   * True when the host's `claimed` was already finalized (or the outcome is
   * partial, which is final). False means "in a best-chain block": record
   * the sale, but keep following `topUpId` for the last word.
   */
  finalized: boolean;
  /** Hex of the host's top-up registration id — stored on the sale for the watcher. */
  topUpId: string;
  /** How many coins the cheque carried. */
  coinCount: number;
  /** Sender timestamp (ms) from the payload. */
  timestamp: number;
}

export interface UseCoinagePaymentOptions {
  /** Arm the flow (mint keys, show QR, listen) only while true. */
  active: boolean;
  /** Decimal amount from the calculator (normalized internally). */
  amount: string;
  onPaid: (result: CoinagePaymentResult) => void;
  /**
   * Called, and awaited, right before each registration with the host, so the
   * caller can persist the claim (see ./pending-claims.ts): from that moment
   * the host may credit the coins even if this page goes away. `topUpIds` are
   * the registrations that may hold them (hex, no 0x).
   */
  onClaimStarting?: (claim: { paymentId: string; requestedAmount: string; topUpIds: string[] }) => Promise<void> | void;
}

export interface UseCoinagePayment {
  status: CoinageStatus;
  qrValue: string | null;
  paymentId: string | null;
  /** Merchant-facing failure text (see `describeTopupFailure`). */
  error: string | null;
  /** Stable kind of the failure, for UI branching and telemetry. */
  errorKind: TopupErrorKind | null;
  /** Which registration of the current claim is running (1-based; 0 before the first). */
  claimAttempt: number;
  /** How many times the cheque being claimed was claimed before (0 on its first claim). */
  claimRetries: number;
  /** The host's progress on the current registration, for the waiting copy. */
  claimStage: ClaimStage | null;
  /**
   * True while the running claim has waited for its coins for a while (see
   * `CHEQUE_STALL_MS`): the cheque may have come from someone other than the
   * customer. The merchant may then cancel the sale; the claim is followed in
   * the background (./claim-handoff.ts), so one that lands is still recorded.
   */
  claimStalled: boolean;
  /** True when Retry has a cheque to claim again. */
  canRetry: boolean;
  /**
   * Register the claim again, under the next id, for the cheques already
   * received. The host is idempotent per id and refuses a busy source, so
   * this can never double-claim one cheque. No-op unless `status === "error"`.
   */
  retryClaim: () => void;
}

export function useCoinagePayment(
  opts: UseCoinagePaymentOptions | null,
): UseCoinagePayment {
  const active = opts?.active ?? false;
  const amount = opts?.amount ?? "";

  const onPaidRef = useRef<UseCoinagePaymentOptions["onPaid"] | undefined>(
    opts?.onPaid,
  );
  onPaidRef.current = opts?.onPaid;
  const onClaimStartingRef = useRef<UseCoinagePaymentOptions["onClaimStarting"]>(opts?.onClaimStarting);
  onClaimStartingRef.current = opts?.onClaimStarting;
  const retryRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<CoinageStatus>("idle");
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<TopupErrorKind | null>(null);
  const [claimAttempt, setClaimAttempt] = useState(0);
  const [claimRetries, setClaimRetries] = useState(0);
  const [claimStage, setClaimStage] = useState<ClaimStage | null>(null);
  const [claimStalled, setClaimStalled] = useState(false);
  const [canRetry, setCanRetry] = useState(false);

  const retryClaim = useCallback(() => {
    retryRef.current?.();
  }, []);

  useEffect(() => {
    if (!active || !amount) {
      setStatus("idle");
      setQrValue(null);
      setPaymentId(null);
      setError(null);
      setErrorKind(null);
      setClaimAttempt(0);
      setClaimRetries(0);
      setClaimStage(null);
      setClaimStalled(false);
      setCanRetry(false);
      retryRef.current = null;
      return;
    }

    let cancelled = false;
    // A claim landed: the sale is paid and nothing else may start.
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    // Every cheque that matched this sale, and which to claim next (see
    // ./cheque-intake.ts for why there can be more than one).
    const book = new ChequeBook();
    // The running claims, by cheque. Aborting one only stops following it.
    const aborts = new Map<string, AbortController>();
    // Registrations made for this sale, across cheques and retries — each gets
    // its own id, so none collides with one the host still remembers.
    let registrations = 0;
    // Pending-claim writes, one after another: two claims persisting at once
    // would read-modify-write the same record.
    let persisting: Promise<void> = Promise.resolve();
    let lastFailure: TopupErrorKind | null = null;
    let pumpTimer: ReturnType<typeof setTimeout> | null = null;
    let pump: (manual?: boolean) => void = () => {};
    let paymentIdForHandoff: string | null = null;
    // Log budget for statements we skip, so a flood of junk on the topic
    // cannot push the real claim's lines out of the captured logs.
    const skips: Partial<Record<SkipReason, number>> = {};
    let duplicates = 0;
    let unlogged = 0;
    let pages = 0;
    let fullReported = false;
    let statementWaitRecorded = false;
    const flowStartedAt = performance.now();

    // The screen follows the running claim; with none, the last failure.
    // Cheques the registration cap holds back: only Retry may run them.
    const heldByCap = () => registrations >= MAX_AUTO_REGISTRATIONS && book.next().entry != null;
    const showProgress = () => {
      if (cancelled || settled) return;
      setCanRetry(book.failedCount() > 0 || heldByCap());
      const leader = book.leader();
      if (leader) {
        setStatus("claiming");
        setClaimStage(leader.stage);
        setClaimAttempt(leader.lastAttempt ?? 0);
        setClaimRetries(Math.max(0, leader.runs - 1));
        setClaimStalled(book.stalled());
        setError(null);
        setErrorKind(null);
        return;
      }
      setClaimStage(null);
      setClaimStalled(false);
      if (lastFailure && (book.failedCount() > 0 || heldByCap())) {
        setErrorKind(lastFailure);
        setError(describeTopupFailure(lastFailure));
        setStatus("error");
      }
    };

    void (async () => {
      try {
        setError(null);
        setErrorKind(null);
        setClaimAttempt(0);
        setClaimRetries(0);
        setClaimStage(null);
        setClaimStalled(false);
        setStatus("preparing");
        const expectedAmount = normalizeAmount(amount);
        const { privateKey, publicKey } = await generateEphemeralKeypair();
        const id = generatePaymentId();
        markClaimInSession(id);
        paymentIdForHandoff = id;
        const topic = deriveTopic(id);
        if (cancelled) return;
        const env = detectHostEnvironment();

        // Claim the matched cheque's coins through the host: register under a
        // fresh id, then follow the host's status reports to a terminal state.
        // The host drives the claim itself (across an app restart if need be)
        // and may show the merchant an acknowledgement sheet in the Polkadot
        // app along the way (see ./claim.ts). lib/host/payments picks the
        // client for this launch's wire codec; both report the same statuses.
        // Set up before the QR goes out, so no customer pays into a sale that
        // could never claim (and NFC never carries a deeplink nobody hears).
        const claimHost = await createClaimHost((call) =>
          withSpan("coinage topUp", call, {
            registration: registrations,
            paymentId: id,
            topic: toHex(topic),
          }),
        );
        if (cancelled) return;

        setPaymentId(id);
        setQrValue(
          buildPayW3sDeeplink({ id, amount: expectedAmount, publicKey }),
        );
        setStatus("waiting");
        recordCoinagePaymentPhase({
          phase: "prepare",
          startedAt: flowStartedAt,
          paymentId: id,
          amount: expectedAmount,
          hostEnv: env,
        });
        const statementWaitStartedAt = performance.now();

        log(`armed: id=${id} amount=${expectedAmount} topic=0x${toHex(topic)} host=${env}`);
        if (env === "standalone") {
          // The host statement store + paymentTopUp(Coins) are host bridge calls.
          // A standalone browser/PWA (no Polkadot App container) can't reach
          // them, so the subscription below will never fire. Surface it instead
          // of spinning forever. (Detection would need a chain-direct statement
          // source + a self-custody claim path.)
          log(
            "WARNING: not running inside a Polkadot App host — the host statement " +
              "store is unavailable, so incoming W3S payments cannot be detected here.",
          );
          captureWarning("no Polkadot host — coins undetectable", { paymentId: id });
        }

        const requestedPlanck = amountToPlanck(expectedAmount, PUSD_DECIMALS);

        const runClaim = async (entry: ChequeEntry) => {
          const claimed = entry.cheque;
          const attempt = registrations + 1;
          registrations = attempt;
          // Synchronous up to here, so the book knows this claim is running
          // before anyone asks it what to start next.
          const previous = book.start(entry, attempt);
          // The registration this run ends up following, once the host accepts one.
          let followed: number | null = null;
          const abort = new AbortController();
          aborts.set(entry.key, abort);
          showProgress();
          const coinLens = claimed.coins.map((c) => c.length).join(",");
          const hostTopUpStartedAt = performance.now();
          log(
            `claiming ${claimed.coins.length} coin(s) [byte lengths: ${coinLens}] for ${expectedAmount} via paymentTopUp(Coins)`,
          );
          log(`  registration ${attempt} id=${toHex(deriveTopUpId(id, attempt))}`);
          if (previous != null) {
            captureWarning("topUp re-registered with a fresh id (manual retry)", { paymentId: id, attempt });
          } else if (attempt > 1) {
            captureWarning("topUp registered for another cheque of the same sale", { paymentId: id, attempt });
          }

          try {
            // A retry can end up following this cheque's previous
            // registration (the host answers SourceBusy while it is live), so
            // keep both.
            const topUpIds = [previous, attempt]
              .filter((n): n is number => n != null && n >= 1)
              .map((n) => topUpIdToHex(deriveTopUpId(id, n)));
            const persist = persisting.then(() =>
              onClaimStartingRef.current?.({ paymentId: id, requestedAmount: expectedAmount, topUpIds }),
            );
            persisting = persist.then(
              () => undefined,
              () => undefined,
            );
            try {
              await persist;
            } catch (persistError) {
              // Not fatal: the claim goes ahead, it just would not survive a restart.
              captureWarning("could not persist the pending claim", { paymentId: id, detail: describeError(persistError) });
            }
            if (cancelled || settled) return;

            const outcome = await claimCoins({
              host: claimHost,
              amountPlanck: requestedPlanck,
              keys: claimed.coins,
              topUpId: (n) => deriveTopUpId(id, n),
              attempt,
              previousAttempt: previous,
              signal: abort.signal,
              onStatus: (status: TopUpStatusEvent) => {
                log(`  status: ${status.type}${status.type === "claimed" ? ` (finalized=${status.finalized})` : ""}`);
                if (status.type === "detecting" || status.type === "claiming") {
                  book.setStage(entry, status.type);
                  // A stage change moves the stall clock: re-plan, not just repaint.
                  pump();
                }
              },
              onFollow: (n) => {
                followed = n;
                book.accepted(entry, n);
              },
              onResubscribe: (n, err) => {
                log(`  status subscription dropped (${describeError(err)}) — re-subscribing (${n})`);
                captureWarning("topUp status subscription dropped — re-subscribing", { paymentId: id, resubscribe: n });
              },
            });
            if (cancelled || settled) return;
            settled = true;
            if (pumpTimer) clearTimeout(pumpTimer);
            // Stop following the other cheques' claims. The host goes on with
            // them, and one may still credit: say so, with their ids, since
            // recording the sale drops the pending claim that lists them.
            const others = book
              .running()
              .filter((e) => e.key !== entry.key && e.lastAttempt != null)
              .map((e) => topUpIdToHex(deriveTopUpId(id, e.lastAttempt!)));
            for (const [key, other] of aborts) if (key !== entry.key) other.abort();
            if (others.length > 0) {
              log(`  other claims still running at the host: ${others.join(", ")}`);
              captureWarning("sale settled with other claims still running", { paymentId: id, topUpIds: others.join(",") });
            }

            const credited = formatAmountFromPlanck(
              outcome.creditedPlanck.toString(),
              PUSD_DECIMALS,
            );
            const partial = outcome.kind === "partial";
            const finalized = partial || outcome.finalized;
            const phaseCommon = {
              paymentId: id,
              amount: credited,
              hostEnv: env,
              coinCount: claimed.coins.length,
              ...(partial ? { reason: `partial: credited ${credited} of ${expectedAmount}` } : {}),
            };
            recordCoinagePaymentPhase({ phase: "host_topup", startedAt: hostTopUpStartedAt, ...phaseCommon });
            recordCoinagePaymentPhase({ phase: "total", startedAt: flowStartedAt, ...phaseCommon });
            if (partial) {
              log(`  claim PARTIAL — credited ${credited} of ${expectedAmount}`);
              captureWarning("topUp credited less than the cheque", {
                paymentId: id,
                requested: expectedAmount,
                credited,
              });
            } else {
              log(`  claim ok — paid (${finalized ? "finalized" : "in block, finality pending"})`);
            }
            setClaimStage(null);
            setClaimStalled(false);
            setStatus("paid");
            onPaidRef.current?.({
              paymentId: id,
              amount: credited,
              requestedAmount: expectedAmount,
              partial,
              finalized,
              topUpId: topUpIdToHex(outcome.topUpId),
              coinCount: claimed.coins.length,
              timestamp: Number(claimed.timestamp),
            });
          } catch (err) {
            if (cancelled || settled) return;
            const kind = classifyTopupError(err);
            const detail = describeError(err);
            const failure = {
              paymentId: id,
              amount: expectedAmount,
              hostEnv: env,
              coinCount: claimed.coins.length,
              outcome: "failure" as const,
              reason: `${kind}: ${detail}`,
            };
            recordCoinagePaymentPhase({ phase: "host_topup", startedAt: hostTopUpStartedAt, ...failure });
            recordCoinagePaymentPhase({ phase: "total", startedAt: flowStartedAt, ...failure });
            log(`  claim FAILED (${kind}): ${detail}`);
            console.error("[coinage] raw topUp error:", err);
            captureWarning(`topUp failed: ${kind}`, { paymentId: id, registrations, detail });
            book.fail(entry, {
              attempt,
              followed,
              settled: creditedNothing(err),
              refusedByHost: err instanceof TopUpRefusal,
            });
            lastFailure = kind;
          } finally {
            if (aborts.get(entry.key) === abort) aborts.delete(entry.key);
            // The next cheque in hand (if any) may go now.
            pump();
          }
        };

        let capReported = false;
        pump = (manual = false) => {
          if (cancelled || settled) return;
          if (pumpTimer) {
            clearTimeout(pumpTimer);
            pumpTimer = null;
          }
          let step = book.next();
          if (step.entry && !manual && registrations >= MAX_AUTO_REGISTRATIONS) {
            if (!capReported) {
              capReported = true;
              log(`  ${registrations} registrations for this sale — further cheques wait for Retry`);
              captureWarning("registration cap reached for one sale", { paymentId: id, registrations });
            }
            step = { entry: null, wakeInMs: step.wakeInMs };
          }
          if (step.entry) {
            void runClaim(step.entry);
            step = book.next();
          }
          if (step.wakeInMs != null) pumpTimer = setTimeout(pump, step.wakeInMs + 50);
          showProgress();
        };

        retryRef.current = () => {
          if (cancelled || settled) return;
          book.retryFailed();
          if (!book.next().entry) return;
          log("manual retry of the claim");
          pump(true);
        };

        const handlePage = (page: HostStatementsPage) => {
          pages += 1;
          const logThisPage = pages <= PAGE_LOG_LIMIT || pages % 100 === 0;
          if (logThisPage) {
            log(`page: ${page.statements.length} statement(s), isComplete=${page.isComplete}`);
          }
          if (!statementWaitRecorded && page.statements.length > 0) {
            statementWaitRecorded = true;
            recordCoinagePaymentPhase({
              phase: "statement_wait",
              startedAt: statementWaitStartedAt,
              paymentId: id,
              amount: expectedAmount,
              hostEnv: env,
              statementCount: page.statements.length,
              isComplete: page.isComplete,
            });
          }

          let arrived = false;
          for (const statement of page.statements) {
            const decryptMatchStartedAt = performance.now();
            const match = matchStatement(privateKey, statement.data, id, expectedAmount);
            if (!match.ok) {
              const seen = (skips[match.reason] = (skips[match.reason] ?? 0) + 1);
              if (seen <= SKIP_LOG_LIMIT) log(`  ${match.detail}`);
              else unlogged += 1;
              // Once per kind of skip and sale is enough to see a wire drift.
              if (seen === 1 && match.reason !== "empty") {
                recordCoinagePaymentPhase({
                  phase: "decrypt_match",
                  startedAt: decryptMatchStartedAt,
                  paymentId: id,
                  amount: expectedAmount,
                  hostEnv: env,
                  outcome: "failure",
                  reason: match.reason,
                });
              }
              continue;
            }

            const offered = book.offer(match.cheque, match.key);
            if (offered === "duplicate" || offered === "exhausted") {
              duplicates += 1;
              if (duplicates <= SKIP_LOG_LIMIT) {
                log(
                  offered === "duplicate"
                    ? "  the same cheque again, already in hand — skip"
                    : "  the same failed cheque again, re-posted too often — skip (Retry still claims it)",
                );
              } else unlogged += 1;
              continue;
            }
            if (offered === "full") {
              if (!fullReported) {
                fullReported = true;
                log(`  more than ${MAX_CHEQUES_PER_SALE} different cheques for one sale — dropping the rest`);
                captureWarning("too many cheques for one sale", { paymentId: id });
              } else unlogged += 1;
              continue;
            }
            arrived = true;
            recordCoinagePaymentPhase({
              phase: "decrypt_match",
              startedAt: decryptMatchStartedAt,
              paymentId: id,
              amount: expectedAmount,
              hostEnv: env,
              coinCount: match.cheque.coins.length,
            });
            log(offered === "again" ? "  match! (a cheque whose claim failed, sent again)" : "  match!");
          }
          // Counted across pages and logged on the page throttle, so a stream
          // of one-statement pages cannot write a line each.
          if (unlogged > 0 && logThisPage) {
            log(`  …and ${unlogged} more statement(s) skipped`);
            unlogged = 0;
          }
          if (arrived) pump();
        };

        // The wrapper's subscription can be interrupted by the host (e.g. a
        // reconnect). If that happens we must re-establish it, otherwise the
        // terminal would silently stop listening and spin forever — even
        // while a claim runs, since that claim may yet fail.
        const subscribeOnce = () => {
          const sub = subscribeHostStatements(topic, (page) => {
            if (cancelled || settled) return;
            try {
              handlePage(page);
            } catch (err) {
              // Nothing a stranger posts may end the subscription.
              log(`page handling failed: ${describeError(err)}`);
              captureWarning("statement page handling failed", { paymentId: id, detail: describeError(err) });
            }
          });

          // Re-arm if the host drops the subscription before we're done.
          sub.onInterrupt?.(() => {
            if (cancelled || settled) return;
            log("subscription interrupted by host — re-subscribing");
            captureWarning("statement subscription interrupted — host drop", { paymentId: id });
            unsubscribe = subscribeOnce();
          });

          return () => sub.unsubscribe();
        };

        unsubscribe = subscribeOnce();
        log("listening on statement store…");
      } catch (err) {
        if (cancelled) return;
        const detail = describeError(err);
        recordCoinagePaymentPhase({
          phase: "total",
          startedAt: flowStartedAt,
          amount,
          outcome: "failure",
          reason: detail,
        });
        log(`setup FAILED: ${detail}`);
        console.error("[coinage] raw setup error:", err);
        // No QR for a sale that cannot claim.
        setQrValue(null);
        setErrorKind("unknown");
        setError(describeTopupFailure("unknown"));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      retryRef.current = null;
      if (pumpTimer) clearTimeout(pumpTimer);
      if (!settled && registrations > 0 && paymentIdForHandoff) {
        // Ended (Cancel, or the screen left) with a claim the host may still
        // credit: follow it in the background once its pending claim is written.
        const handoffId = paymentIdForHandoff;
        log(`sale ended before its claim settled — following it in the background`);
        void persisting.then(() => handOffClaim(handoffId));
      }
      for (const abort of aborts.values()) abort.abort();
      if (unsubscribe) unsubscribe();
    };
  }, [active, amount]);

  return {
    status,
    qrValue,
    paymentId,
    error,
    errorKind,
    claimAttempt,
    claimRetries,
    claimStage,
    claimStalled,
    canRetry,
    retryClaim,
  };
}
