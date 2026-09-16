"use client";

import { useEffect } from "react";
import { useAccount } from "@/lib/web3";
import { isInHost } from "@/lib/host/detect";
import { resumePendingTopUpWatches } from "@/lib/payments/coinage/topup-watcher";

/**
 * Re-arms the background claim watcher for every coins sale that was recorded
 * on best-block but whose claim has no last word yet (app restarted, watch
 * expired, host was unreachable). Runs once the host has handed us an
 * account — that is the point the host bridge is known to be up, and the
 * status subscription rides on it. See lib/payments/coinage/topup-watcher.ts.
 */
export function TopUpWatcherBoot() {
  const { account } = useAccount();

  useEffect(() => {
    if (!account || !isInHost()) return;
    resumePendingTopUpWatches().catch((err) => {
      console.warn("[TopUpWatcher] resume failed:", err);
    });
  }, [account]);

  return null;
}
