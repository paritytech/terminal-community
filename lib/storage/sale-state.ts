import type { SaleRecord } from "./types";

/**
 * Where a recorded sale stands, for History:
 *
 *   received   — final, full amount
 *   confirming — recorded on best-block, the claim has no last word yet
 *   partial    — final, but the host credited less than the cheque asked for
 *   reverted   — the host's last word was that nothing landed
 */
export type SaleClaimState = "received" | "confirming" | "partial" | "reverted";

export function saleClaimState(sale: Pick<SaleRecord, "finalizedAt" | "revertedAt" | "requestedAmount" | "topUpId">): SaleClaimState {
  if (sale.revertedAt) return "reverted";
  if (sale.requestedAmount) return "partial";
  // Coins sales carry a topUpId; an older record without one is treated as
  // received.
  if (sale.topUpId && !sale.finalizedAt) return "confirming";
  return "received";
}
