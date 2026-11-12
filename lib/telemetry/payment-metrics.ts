/**
 * Payment measurements, written to the local log.
 *
 *   - `recordPaymentOutcome` — one line per sale: success or failure, with
 *     method, source and the failure reason.
 *   - `recordCoinagePaymentPhase` — how long each W3S Coinage phase took:
 *     QR setup, statement delivery, decrypt/match, the host top-up.
 *   - `recordFinalizationLatency` — time from best-block detection to GRANDPA
 *     finality, or that the watch expired first.
 *
 * Fire-and-forget: recording never throws into the caller's flow.
 */

"use client";

export type PaymentMethodKind = "voucher" | "coins";

export type CoinagePaymentPhase =
  | "prepare"
  | "statement_wait"
  | "decrypt_match"
  | "host_topup"
  | "total";

export interface CoinagePaymentPhaseParams {
  phase: CoinagePaymentPhase;
  /** `performance.now()` timestamp from the start of this phase. */
  startedAt: number;
  paymentId?: string;
  amount?: string;
  hostEnv?: string;
  coinCount?: number;
  statementCount?: number;
  isComplete?: boolean;
  outcome?: "success" | "failure";
  reason?: string;
}

export interface PaymentOutcomeParams {
  outcome: "success" | "failure";
  /** Settings → Payment Method: standard pUSD voucher vs. W3S Coinage. */
  method: PaymentMethodKind;
  /** Decimal amount string for context. */
  amount?: string;
  /** Where the sale originated — "items" checkout vs. "direct" keypad. */
  source?: string;
  saleId?: string;
  terminalId?: string;
  merchantId?: string;
  /** Populated on failure — the human-readable reason. */
  reason?: string;
}

/** Drop undefined fields so the log line stays readable. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** Record a terminal payment as success or failure. */
export function recordPaymentOutcome(params: PaymentOutcomeParams): void {
  const log = params.outcome === "success" ? console.info : console.warn;
  log(
    `[payment] ${params.outcome}`,
    defined({
      method: params.method,
      source: params.source ?? "direct",
      amount: params.amount,
      saleId: params.saleId,
      terminalId: params.terminalId ?? "unbound",
      merchantId: params.merchantId ?? "unbound",
      reason: params.reason,
    }),
  );
}

/** Record how long a W3S Coinage terminal-side phase took. */
export function recordCoinagePaymentPhase(params: CoinagePaymentPhaseParams): void {
  const outcome = params.outcome ?? "success";
  const latencyMs = Math.round(Math.max(0, performance.now() - params.startedAt));
  const log = outcome === "success" ? console.info : console.warn;
  log(
    `[payment.coinage] ${params.phase} ${outcome} in ${latencyMs}ms`,
    defined({
      paymentId: params.paymentId,
      amount: params.amount,
      hostEnv: params.hostEnv,
      coinCount: params.coinCount,
      statementCount: params.statementCount,
      isComplete: params.isComplete,
      reason: params.reason,
    }),
  );
}

export interface FinalizationLatencyParams {
  saleId: string;
  /** ms between best-block detection (watch registration) and the outcome. */
  latencyMs: number;
  /** true = GRANDPA finality landed; false = the watch fuse expired first. */
  finalized: boolean;
  /** `performance.now()`-relative timestamp when the watch was registered. */
  startedAt?: number;
}

/** Record the time a sale took to cross GRANDPA finality, or that it never did. */
export function recordFinalizationLatency(params: FinalizationLatencyParams): void {
  const latencyMs = Math.round(params.latencyMs);
  const log = params.finalized ? console.info : console.warn;
  log(
    `[payment.finalization] ${params.finalized ? "finalized" : "timed out"} after ${latencyMs}ms`,
    { saleId: params.saleId },
  );
}
