/**
 * Live merchant coin balance from the host (`paymentBalanceSubscribe`).
 *
 * Updates whenever coins are claimed, so it's a quick way to watch the balance
 * move as payments come in. Host-only — a standalone browser/PWA can't reach
 * the bridge, so it reports `unavailable` there.
 */

"use client";

import { useEffect, useState } from "react";
import { subscribeHostBalance } from "@/lib/host/payments";

import { detectHostEnvironment } from "@/lib/host";

export type CoinBalanceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export interface UseCoinBalance {
  /** Available balance in planck (smallest unit); null until the first update. */
  availablePlanck: bigint | null;
  status: CoinBalanceStatus;
  error: string | null;
}

export function useCoinBalance(): UseCoinBalance {
  const [availablePlanck, setAvailablePlanck] = useState<bigint | null>(null);
  const [status, setStatus] = useState<CoinBalanceStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (detectHostEnvironment() === "standalone") {
      setStatus("unavailable");
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const subscribeOnce = (): (() => void) => {
      // The live client's balance, whichever codec it speaks (lib/host/payments).
      const sub = subscribeHostBalance((available) => {
        if (cancelled) return;
        setAvailablePlanck(available);
        setStatus("ready");
      });
      // The host can drop the subscription (e.g. a reconnect) — re-establish it,
      // otherwise the balance would silently freeze.
      sub.onInterrupt?.(() => {
        if (cancelled) return;
        unsubscribe = subscribeOnce();
      });
      return () => sub.unsubscribe();
    };

    try {
      setStatus("loading");
      unsubscribe = subscribeOnce();
    } catch (err) {
      if (!cancelled) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return { availablePlanck, status, error };
}
