"use client";

import { useEffect } from "react";
import { useAccount } from "@/lib/web3";
import { awaitHostRuntime, isInHost } from "@/lib/host/detect";
import { hostPaymentsAvailable } from "@/lib/host/payments";
import {
  claimStatusHost,
  resumePendingTopUpWatches,
  watchTopUpFinality,
} from "@/lib/payments/coinage/topup-watcher";
import { resumePendingClaims } from "@/lib/payments/coinage/pending-claims";
import { findFirstByField } from "@/lib/storage/host-storage";
import type { SaleRecord } from "@/lib/storage/types";

/**
 * Re-arms the background claim watcher for every coins sale that was recorded
 * on best-block but whose claim has no last word yet (app restarted, watch
 * expired, host was unreachable). Runs once the host has handed us an
 * account — that is the point the host bridge is known to be up, and the
 * status subscription rides on it. See lib/payments/coinage/topup-watcher.ts.
 */
export function TopUpWatcherBoot() {
  const { account } = useAccount();
  // Keyed on the address: the account object is replaced several times per
  // launch (persisted, then from the host, then its first push), and each
  // replacement would otherwise re-ask the host about every pending sale.
  const address = account?.address;

  useEffect(() => {
    if (!address || !isInHost()) return;
    void awaitHostRuntime()
      .then(() => hostPaymentsAvailable())
      .then((available) => {
        // A TrUAPI core without the payment bridge has no statuses to follow.
        // Sales it would leave confirming are picked up again the next time
        // the app runs on a host that has them.
        if (!available) return;
        return Promise.all([
          resumePendingTopUpWatches(),
          // Claims an earlier launch handed to the host but never saw settle.
          resumePendingClaims({
            host: claimStatusHost(),
            saleExists: async (saleId) => !!(await findFirstByField<SaleRecord>("sales", "saleId", saleId)),
            watchFinality: watchTopUpFinality,
          }),
        ]);
      })
      .catch((err) => {
        console.warn("[TopUpWatcher] resume failed:", err);
      });
  }, [address]);

  return null;
}
