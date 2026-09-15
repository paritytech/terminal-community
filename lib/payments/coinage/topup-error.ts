import { PaymentTopUpErr } from "@novasamatech/host-api";
import { ClaimCancelledError, NotClaimedError, NothingClaimedError } from "./claim";

/**
 * Stable, queryable kind for a claim failure (string attr → count_if), and
 * the one place the merchant-facing wording for each lives.
 *
 *   timeout        — a registration failed with the host's "not yet" (coins
 *                    not on chain), or the wait was interrupted; retrying can
 *                    succeed
 *   not_claimed    — the host's last word: nothing (or nothing more) landed
 *   declined       — the host refused the claim outright
 *   invalid_source — the host could not read the coin keys we passed
 *   host           — the bridge / host app itself was unreachable or busy
 *   cancelled      — we stopped (sale ended)
 *   unknown        — anything else
 */
export type TopupErrorKind =
  | "timeout"
  | "not_claimed"
  | "declined"
  | "invalid_source"
  | "host"
  | "cancelled"
  | "unknown";

/** The `PaymentTopUpErr::…` (or other codec error) name, if this is one. */
export function hostErrorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

function textOf(err: unknown): string {
  if (err instanceof Error) {
    const o = err as Error & { payload?: { reason?: unknown }; value?: { reason?: unknown } };
    const reason = o.payload?.reason ?? o.value?.reason;
    return `${err.name} ${err.message} ${typeof reason === "string" ? reason : ""}`;
  }
  if (typeof err === "string") return err;
  const o = err as Record<string, unknown> | null;
  const tag = o && typeof o.tag === "string" ? o.tag : "";
  const reason =
    o && typeof (o.value as Record<string, unknown> | undefined)?.reason === "string"
      ? String((o.value as Record<string, unknown>).reason)
      : "";
  return `${tag} ${reason}`;
}

export function classifyTopupError(err: unknown): TopupErrorKind {
  if (err instanceof ClaimCancelledError) return "cancelled";
  if (err instanceof NothingClaimedError || err instanceof NotClaimedError) return "not_claimed";
  if (err instanceof PaymentTopUpErr.InvalidSource) return "invalid_source";
  if (err instanceof PaymentTopUpErr.AlreadyExists || err instanceof PaymentTopUpErr.SourceBusy) return "host";
  // Older hosts (host-api 0.9.x) still send this variant.
  if (hostErrorName(err) === "PaymentTopUpErr::InsufficientFunds") return "declined";

  const text = textOf(err);
  if (/NotClaimed|no coins were claimed|nothing (was )?claimed/i.test(text)) return "not_claimed";
  if (/Detecting|Claiming|did not appear|time?d?\s?out|timeout|deadline|interrupted/i.test(text)) return "timeout";
  if (/declin|insufficient|reject/i.test(text)) return "declined";
  if (/host|bridge|unavailable|disconnect|busy|not found/i.test(text)) return "host";
  return "unknown";
}

/**
 * What the merchant reads on the terminal for a failed claim. Plain words, no
 * host internals — the raw reason goes to the console and telemetry instead.
 */
export function describeTopupFailure(kind: TopupErrorKind): string {
  switch (kind) {
    case "timeout":
      return "The coins haven't reached the chain yet. If the Polkadot app is showing a message, dismiss it, then retry.";
    case "not_claimed":
      return "No coins arrived for this payment. Ask the customer to check their Polkadot app, then retry.";
    case "declined":
      return "The Polkadot app declined this payment.";
    case "invalid_source":
      return "The Polkadot app couldn't read the coins in this payment.";
    case "host":
      return "Lost the connection to the Polkadot app. Open it, then retry.";
    case "cancelled":
      return "The claim was stopped.";
    default:
      return "Couldn't claim the payment. If the Polkadot app is showing a message, dismiss it, then retry.";
  }
}
