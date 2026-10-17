/**
 * Build-time feature flags.
 *
 * Gates what shows up in the UI so we can ship the simplest terminal (enter an
 * amount, the customer pays) while the code for the bigger features stays in
 * the tree, ready to come back. Flip a constant here (or set the matching
 * NEXT_PUBLIC_FEATURE_* var for one build) and the gated UI reappears —
 * nothing else to wire up.
 *
 * Static export inlines `process.env.NEXT_PUBLIC_*` at build time, so these
 * are constants in the bundle: a flag can't change at runtime, and the
 * bundler drops the branches behind a `false` flag.
 *
 *   NEXT_PUBLIC_FEATURE_BECOME_MERCHANT=1 npm run build
 *
 * Accepted values: "1" / "true" turn a flag on, "0" / "false" turn it off,
 * unset falls back to the default given here.
 */

function flag(env: string | undefined, fallback: boolean): boolean {
  if (env === undefined || env === "") return fallback;
  return env === "1" || env.toLowerCase() === "true";
}

export const FEATURES = {
  /**
   * "Become a Merchant" onboarding entry points — the Home tile and the
   * Settings card that lead into /merchant — plus the Home "Export CSV" tile.
   * Off for R1: the flow (and what it unlocks — Reports, Merchant Profile,
   * Receipt, Show Items in Checkout) is built but parked until there is more
   * to put behind it. The routes stay reachable by URL; only the buttons are
   * gated, so /home/export still generates, stores and saves CSV reports and
   * comes back to Home the moment this flag flips.
   */
  becomeMerchant: flag(process.env.NEXT_PUBLIC_FEATURE_BECOME_MERCHANT, false),

  /**
   * NFC tap-to-pay on the payment QR screen: mirror the payment deeplink onto
   * the host NFC tag (HCE) and mention "tap NFC" in the banner text. Off for
   * R1 — the screen says "Scan QR to pay" and nothing is emitted.
   */
  nfcTapToPay: flag(process.env.NEXT_PUBLIC_FEATURE_NFC_TAP_TO_PAY, false),

  /**
   * Refund entry points (payment-received screen, History). Off for R1 —
   * refunds aren't implemented yet, so the button only said so.
   */
  refunds: flag(process.env.NEXT_PUBLIC_FEATURE_REFUNDS, false),

  /**
   * Cash out: the Home tile and /home/cash-out, which hand today's sales (or
   * an amount the merchant types) to getcash to send out of the purse
   * (lib/payments/cash-out.ts). Off until getcash takes the hand-off's amount
   * and its bank payout runs outside the sandbox.
   */
  cashOut: flag(process.env.NEXT_PUBLIC_FEATURE_CASH_OUT, false),
} as const;

export type FeatureName = keyof typeof FEATURES;
