/**
 * Following claims to the sale they settle when no screen follows them.
 *
 * A claim is live at the host until the host gives its last word, whatever
 * the terminal does. When the sale's screen stops following one — the
 * merchant cancelled a claim stuck waiting for coins, or left the terminal
 * mid-claim — its pending claim (./pending-claims.ts) is handed over here and
 * followed in the background, exactly as a relaunch would follow it. A claim
 * that lands is recorded now, not at the next launch.
 */

import { findFirstByField } from "@/lib/storage/host-storage";
import type { SaleRecord } from "@/lib/storage/types";
import { releaseClaimFromSession, resumePendingClaims, type ResumeDeps } from "./pending-claims";
import { claimStatusHost, watchTopUpFinality } from "./topup-watcher";

/** What resuming pending claims needs on this host. */
export function resumeDeps(): ResumeDeps {
  return {
    host: claimStatusHost(),
    saleExists: async (saleId) => !!(await findFirstByField<SaleRecord>("sales", "saleId", saleId)),
    watchFinality: watchTopUpFinality,
  };
}

/**
 * Follow `paymentId`'s pending claim in the background from now on. Call it
 * once its pending claim is written.
 */
export function handOffClaim(paymentId: string): void {
  releaseClaimFromSession(paymentId);
  void resumePendingClaims(resumeDeps()).catch((err) => {
    console.warn("[ClaimHandoff] following the claim failed:", err);
  });
}
