/**
 * Cash out: send the merchant's CASH out of the purse to a bank account, a
 * card or a crypto address, through getcash.
 *
 * The coins every sale claims land in the merchant's host purse
 * (`paymentTopUp(Coins)`, ./coinage/claim.ts), and getcash's withdrawal
 * spends from that same purse. So the terminal only hands over: it opens
 * getcash at its withdrawal with the amount and the route chosen, the
 * merchant confirms there (the host asks before anything leaves the purse,
 * and a bank or card sale runs the provider's KYC), and getcash's background
 * worker does the rest: the swap, the XCM to Asset Hub, the payout. The
 * terminal does not hear back; the purse balance dropping is the only sign.
 *
 *   polkadot://getcash.paseo/#/withdraw?amount=120.5&route=bank
 *
 * `host_navigate_to` routes a `.dot` / `.paseo` / `.testnet` name to that
 * product (no permission needed) and keeps the path, query and fragment, so
 * getcash's hash router reads `amount` and `route` as its route query. A
 * `.paseo` name opens only while the Polkadot app is on Paseo. On Android an
 * already open getcash tab is focused as it was and the parameters are lost.
 * Set NEXT_PUBLIC_GETCASH_PRODUCT to point a build at another deployment of
 * it (e.g. a `pr<N>-getcash.paseo` preview).
 */

"use client";

import { enumValue } from "@novasamatech/host-api";
import { hostApi } from "@novasamatech/host-api-wrapper";

import { isInHost } from "@/lib/host/detect";

export const GETCASH_PRODUCT = process.env.NEXT_PUBLIC_GETCASH_PRODUCT?.trim() || "getcash.paseo";

/** getcash's withdrawal, a hash route. */
export const CASH_OUT_ROUTE = "/#/withdraw";

export type CashOutRoute = "bank" | "card" | "crypto";

/** CASH has 6 decimals in the purse; getcash's withdrawal keypad takes 2. */
export const CASH_PLANCK_DECIMALS = 6;
export const CASH_OUT_DECIMALS = 2;

/**
 * getcash's withdrawal bounds (its `withdrawalSelectorConfig`), mirrored so
 * the terminal can say so before handing over. getcash checks them again.
 */
export const CASH_OUT_MINIMUM_PLANCK = 10_000_000n;
export const CASH_OUT_MAXIMUM_PLANCK = 2_000_000_000n;

const PLANCK_PER_CENT = 10n ** BigInt(CASH_PLANCK_DECIMALS - CASH_OUT_DECIMALS);

/** Drops what the keypad can't carry. Down, never up: the purse must cover it. */
export function floorToCashOutScale(planck: bigint): bigint {
  if (planck <= 0n) return 0n;
  return planck - (planck % PLANCK_PER_CENT);
}

/** Planck → getcash's amount string: up to 2 decimals, no trailing zeros ("120.5"). */
export function cashOutAmountString(planck: bigint): string {
  const cents = floorToCashOutScale(planck) / PLANCK_PER_CENT;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(CASH_OUT_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** What the merchant typed → planck; null unless it is a plain amount with at most 2 decimals. */
export function parseCashOutInput(text: string): bigint | null {
  const match = /^(\d+)(?:[.,](\d{0,2}))?$/.exec(text.trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(CASH_OUT_DECIMALS, "0"));
  return cents * PLANCK_PER_CENT;
}

/**
 * What "today's sales" offers: today's income, but never more than the purse
 * holds (some of it may already be cashed out). Null while the purse is
 * unknown, so the terminal doesn't offer a figure it can't back.
 */
export function todaysCashOutPlanck(todayPlanck: bigint, balancePlanck: bigint | null): bigint | null {
  if (balancePlanck === null) return null;
  const amount = todayPlanck < balancePlanck ? todayPlanck : balancePlanck;
  return floorToCashOutScale(amount);
}

export type CashOutCheck =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "below-minimum" }
  | { kind: "above-maximum" }
  | { kind: "above-balance" };

/** The same bounds getcash applies, in its order: its own, then the purse's. */
export function checkCashOutAmount(planck: bigint, balancePlanck: bigint | null): CashOutCheck {
  const amount = floorToCashOutScale(planck);
  if (amount <= 0n) return { kind: "empty" };
  if (amount < CASH_OUT_MINIMUM_PLANCK) return { kind: "below-minimum" };
  if (amount > CASH_OUT_MAXIMUM_PLANCK) return { kind: "above-maximum" };
  if (balancePlanck !== null && amount > floorToCashOutScale(balancePlanck)) {
    return { kind: "above-balance" };
  }
  return { kind: "ok" };
}

/** The deeplink that opens getcash's withdrawal with the amount and route chosen. */
export function buildCashOutDeeplink(
  { amountPlanck, route }: { amountPlanck: bigint; route: CashOutRoute },
  product: string = GETCASH_PRODUCT,
): string {
  const params = new URLSearchParams({ amount: cashOutAmountString(amountPlanck), route });
  return `polkadot://${product}${CASH_OUT_ROUTE}?${params.toString()}`;
}

export class CashOutUnavailableError extends Error {
  constructor() {
    super("Cash out needs the Polkadot app");
    this.name = "CashOutUnavailableError";
  }
}

/**
 * Asks the host to open getcash at the deeplink. Resolves once the host has
 * accepted the navigation; rejects with the host's reason
 * (`NavigateToErr::PermissionDenied` / `::Unknown`), or with
 * `CashOutUnavailableError` outside a host container.
 */
export async function openCashOut(deeplink: string): Promise<void> {
  if (!isInHost()) throw new CashOutUnavailableError();
  const result = await hostApi.navigateTo(enumValue("v1", deeplink));
  if (result.isErr()) {
    const reason = result.error.value as unknown;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}
