/**
 * Payment measurements, written to the local log.
 *
 *   - `recordPaymentOutcome` — one line per sale: success, partial (the host
 *     credited less than asked) or failure, with method, source and reason.
 *   - `recordCoinagePaymentPhase` — how long each W3S Coinage phase took:
 *     QR setup, statement delivery, decrypt/match, the host top-up.
 *
 * Fire-and-forget: recording never throws into the caller's flow.
 */

"use client";

export type PaymentMethodKind = "coins";

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
  outcome: "success" | "partial" | "failure";
  /** How the sale settled — W3S Coinage through the host. */
  method: PaymentMethodKind;
  /** Decimal amount string for context. */
  amount?: string;
  /** Where the sale originated — "items" checkout vs. "direct" keypad. */
  source?: string;
  saleId?: string;
  terminalId?: string;
  merchantId?: string;
  /** Populated on failure or partial — the human-readable reason. */
  reason?: string;
}

/** Drop undefined fields so the log line stays readable. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** Record a terminal payment as success, partial or failure. */
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
