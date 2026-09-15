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
  // Only coins sales carry a topUpId; anything else recorded here is treated
  // as received (the voucher flow is not in use).
  if (sale.topUpId && !sale.finalizedAt) return "confirming";
  return "received";
}
