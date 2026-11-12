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
import { isBalanceWithheld, isPaymentsUnsupported } from "@/lib/payments/host-reachability";

import { detectHostEnvironment } from "@/lib/host";

/** Pause before following the balance again after the host dropped it. */
const RESUBSCRIBE_DELAY_MS = 2_000;

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
    let retry: ReturnType<typeof setTimeout> | null = null;

    const subscribeOnce = (): (() => void) => {
      // The live client's balance, whichever codec it speaks (lib/host/payments).
      const sub = subscribeHostBalance((available) => {
        if (cancelled) return;
        setAvailablePlanck(available);
        setStatus("ready");
      });
      // The host can drop the subscription (e.g. a reconnect) — re-establish it,
      // otherwise the balance would silently freeze. A host that withholds the
      // balance (no BalanceAccess) or has no payments answers the same way on
      // every try, so that is final for this screen.
      sub.onInterrupt?.((payload) => {
        if (cancelled) return;
        if (isBalanceWithheld(payload) || isPaymentsUnsupported(payload)) {
          setStatus("unavailable");
          return;
        }
        retry = setTimeout(() => {
          if (!cancelled) unsubscribe = subscribeOnce();
        }, RESUBSCRIBE_DELAY_MS);
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
      if (retry) clearTimeout(retry);
      unsubscribe?.();
    };
  }, []);

  return { availablePlanck, status, error };
}
