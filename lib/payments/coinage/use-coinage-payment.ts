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
 *      validates id + amount, then claims the bearer coins into the merchant
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
import {
  createPaymentManager,
  createStatementStore,
} from "@novasamatech/host-api-wrapper";
import { decryptStatementData } from "./ecies";

import { detectHostEnvironment } from "@/lib/host";
import { recordCoinagePaymentPhase } from "@/lib/telemetry";
import { amountToPlanck, formatAmountFromPlanck } from "@/lib/utils/format";
import { PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { generateEphemeralKeypair, generatePaymentId } from "./keys";
import { deriveTopic } from "./topic";
import { buildPayW3sDeeplink, normalizeAmount } from "./deeplink";
import { withSpan, captureWarning, withPaymentTrace } from "@/lib/telemetry";
import { classifyTopupError, describeTopupFailure, type TopupErrorKind } from "./topup-error";
import {
  claimCoins,
  deriveTopUpId,
  topUpIdToHex,
  type ClaimHost,
  type TopUpStatusEvent,
} from "./claim";

type ChequePayload = ReturnType<typeof decryptStatementData>["payload"];

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

/** Where the host is with the current claim, while `status === "claiming"`. */
export type ClaimStage = "registering" | "detecting" | "claiming";

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
  /** The host's progress on the current registration, for the waiting copy. */
  claimStage: ClaimStage | null;
  /**
   * Register the claim again, under the next id, for the cheque already
   * received. The host is idempotent per id and refuses a busy source, so
   * this can never double-claim. No-op unless `status === "error"`.
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
  const retryRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<CoinageStatus>("idle");
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<TopupErrorKind | null>(null);
  const [claimAttempt, setClaimAttempt] = useState(0);
  const [claimStage, setClaimStage] = useState<ClaimStage | null>(null);

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
      setClaimStage(null);
      retryRef.current = null;
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    // A cheque has matched and its claim is running or has run: further
    // statements are ignored until that claim fails, so one payment cannot be
    // claimed twice in parallel.
    let processed = false;
    let claimInFlight = false;
    // The matched cheque, kept for the manual retry after a failed claim.
    let pendingClaim: ChequePayload | null = null;
    // Registrations made for this sale across auto retries and manual retries —
    // every registration gets its own id, so a retry never collides with a
    // registration the host still remembers.
    let registrations = 0;
    // Aborts the claim in flight when the sale ends.
    let claimAbort: AbortController | null = null;
    let statementWaitRecorded = false;
    const flowStartedAt = performance.now();

    void (async () => {
      try {
        setError(null);
        setErrorKind(null);
        setClaimAttempt(0);
        setClaimStage(null);
        setStatus("preparing");
        const expectedAmount = normalizeAmount(amount);
        const { privateKey, publicKey } = await generateEphemeralKeypair();
        const id = generatePaymentId();
        const topic = deriveTopic(id);
        if (cancelled) return;
        const env = detectHostEnvironment();

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

        const store = createStatementStore();
        const manager = createPaymentManager();

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

        // Claim the matched cheque's coins through the host: register under a
        // fresh id, then follow the host's status reports to a terminal state.
        // The host drives the claim itself (across an app restart if need be)
        // and may show the merchant an acknowledgement sheet in the Polkadot
        // app along the way (see ./claim.ts).
        const claimHost: ClaimHost = {
          topUp: (planck, keys, topUpId) =>
            // trace_id = payment id ⇒ this claim correlates cross-system
            // (payer / processor) in one Sentry trace. See e2e-correlation design.
            withPaymentTrace(id, () =>
              withSpan(
                "coinage topUp",
                "payment.coinage.topup",
                () => manager.topUp(planck, { type: "coins", keys }, topUpId),
                {
                  "topup.registration": String(registrations),
                  "topup.id": toHex(topUpId),
                  "payment.id": id,
                  "payment.topic": toHex(topic),
                  "pay.role": "terminal",
                  "pay.phase": "claimed",
                },
              ),
            ),
          subscribeTopUpStatus: (topUpId, onStatus) => manager.subscribeTopUpStatus(topUpId, onStatus),
        };

        const runClaim = async (claimed: ChequePayload) => {
          if (cancelled || claimInFlight) return;
          claimInFlight = true;
          const abort = new AbortController();
          claimAbort = abort;
          setStatus("claiming");
          setClaimStage("registering");
          setError(null);
          setErrorKind(null);
          const requestedPlanck = amountToPlanck(claimed.amount, PUSD_DECIMALS);
          const coinLens = claimed.coins.map((c) => c.length).join(",");
          const hostTopUpStartedAt = performance.now();
          log(
            `claiming ${claimed.coins.length} coin(s) [byte lengths: ${coinLens}] for ${claimed.amount} via paymentTopUp(Coins)`,
          );

          const attempt = registrations + 1;
          registrations = attempt;
          setClaimAttempt(attempt);
          log(`  registration ${attempt} id=${toHex(deriveTopUpId(id, attempt))}`);
          if (attempt > 1) {
            captureWarning("topUp re-registered with a fresh id (manual retry)", { paymentId: id, attempt });
          }

          try {
            const outcome = await claimCoins({
              host: claimHost,
              amountPlanck: requestedPlanck,
              keys: claimed.coins,
              topUpId: (n) => deriveTopUpId(id, n),
              attempt,
              signal: abort.signal,
              onStatus: (status: TopUpStatusEvent) => {
                log(`  status: ${status.type}${status.type === "claimed" ? ` (finalized=${status.finalized})` : ""}`);
                if (status.type === "detecting" || status.type === "claiming") setClaimStage(status.type);
              },
              onResubscribe: (n, err) => {
                log(`  status subscription dropped (${describeError(err)}) — re-subscribing (${n})`);
                captureWarning("topUp status subscription dropped — re-subscribing", { paymentId: id, resubscribe: n });
              },
            });
            if (cancelled) return;

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
              ...(partial ? { reason: `partial: credited ${credited} of ${claimed.amount}` } : {}),
            };
            recordCoinagePaymentPhase({ phase: "host_topup", startedAt: hostTopUpStartedAt, ...phaseCommon });
            recordCoinagePaymentPhase({ phase: "total", startedAt: flowStartedAt, ...phaseCommon });
            if (partial) {
              log(`  claim PARTIAL — credited ${credited} of ${claimed.amount}`);
              captureWarning("topUp credited less than the cheque", {
                paymentId: id,
                requested: claimed.amount,
                credited,
              });
            } else {
              log(`  claim ok — paid (${finalized ? "finalized" : "in block, finality pending"})`);
            }
            setClaimStage(null);
            setStatus("paid");
            onPaidRef.current?.({
              paymentId: id,
              amount: credited,
              requestedAmount: claimed.amount,
              partial,
              finalized,
              topUpId: topUpIdToHex(outcome.topUpId),
              coinCount: claimed.coins.length,
              timestamp: Number(claimed.timestamp),
            });
          } catch (err) {
            if (cancelled) return;
            const kind = classifyTopupError(err);
            const detail = describeError(err);
            const failure = {
              paymentId: id,
              amount: claimed.amount,
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
            setClaimStage(null);
            setErrorKind(kind);
            setError(describeTopupFailure(kind));
            setStatus("error");
            // Let a fresh statement for this sale (or the manual retry) try again.
            processed = false;
          } finally {
            claimInFlight = false;
            if (claimAbort === abort) claimAbort = null;
          }
        };

        retryRef.current = () => {
          if (cancelled || claimInFlight || !pendingClaim) return;
          processed = true;
          log("manual retry of the claim");
          void runClaim(pendingClaim);
        };

        // The wrapper's subscription can be interrupted by the host (e.g. a
        // reconnect). If that happens we must re-establish it, otherwise the
        // terminal would silently stop listening and spin forever.
        const subscribeOnce = () => {
          const sub = store.subscribe({ matchAny: [topic] }, (page) => {
            if (cancelled || processed) return;
            log(
              `page: ${page.statements.length} statement(s), isComplete=${page.isComplete}`,
            );
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

            for (const statement of page.statements) {
              const data = statement.data;
              if (!data || data.length === 0) {
                log("  statement has no data — skip");
                continue;
              }

              let payload: ChequePayload;
              const decryptMatchStartedAt = performance.now();
              try {
                ({ payload } = decryptStatementData(privateKey, data));
              } catch (err) {
                // Not ours, or malformed — skip, but say why (a decrypt error
                // here on our own topic usually means a wire-format drift).
                log(
                  `  decrypt failed (len=${data.length}): ${err instanceof Error ? err.message : String(err)}`,
                );
                recordCoinagePaymentPhase({
                  phase: "decrypt_match",
                  startedAt: decryptMatchStartedAt,
                  paymentId: id,
                  amount: expectedAmount,
                  hostEnv: env,
                  outcome: "failure",
                  reason: "decrypt_failed",
                });
                continue;
              }

              if (payload.id !== id) {
                log(`  id mismatch: got "${payload.id}", want "${id}" — skip`);
                recordCoinagePaymentPhase({
                  phase: "decrypt_match",
                  startedAt: decryptMatchStartedAt,
                  paymentId: id,
                  amount: expectedAmount,
                  hostEnv: env,
                  outcome: "failure",
                  reason: "id_mismatch",
                });
                continue;
              }
              if (normalizeAmount(payload.amount) !== expectedAmount) {
                log(
                  `  amount mismatch: got "${payload.amount}", want "${expectedAmount}" — skip`,
                );
                recordCoinagePaymentPhase({
                  phase: "decrypt_match",
                  startedAt: decryptMatchStartedAt,
                  paymentId: id,
                  amount: expectedAmount,
                  hostEnv: env,
                  outcome: "failure",
                  reason: "amount_mismatch",
                });
                continue;
              }

              processed = true;
              pendingClaim = payload;
              recordCoinagePaymentPhase({
                phase: "decrypt_match",
                startedAt: decryptMatchStartedAt,
                paymentId: id,
                amount: payload.amount,
                hostEnv: env,
                coinCount: payload.coins.length,
              });
              log("  match!");
              void runClaim(payload);
              break;
            }
          });

          // Re-arm if the host drops the subscription before we're done.
          sub.onInterrupt?.(() => {
            if (cancelled || processed) return;
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
        setErrorKind("unknown");
        setError(describeTopupFailure("unknown"));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      retryRef.current = null;
      claimAbort?.abort();
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
    claimStage,
    retryClaim,
  };
}
