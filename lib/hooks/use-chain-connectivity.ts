"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isChainReachable } from "@/lib/payments/chain-reachability";

export interface ChainConnectivity {
  /** Last known reachability of the settlement path (so we can actually settle a sale). */
  isOnline: boolean;
  /** A reachability probe is in flight. */
  isChecking: boolean;
  /** Epoch millis of the last completed check, or null before the first. */
  lastCheckedAt: number | null;
  /** Run an immediate check (e.g. right before generating a sale QR). */
  check: () => Promise<boolean>;
}

export interface ChainConnectivityOptions {
  intervalMs?: number;
  /**
   * What "reachable" means for the active payment method: a direct chain read
   * for pUSD (`isChainReachable`, the default), the host payments bridge for
   * coins (`isHostPaymentsReachable`). `null` = not known yet (the payment
   * method setting is still loading) — nothing is probed and the indicator
   * stays green rather than flashing "offline" against the wrong path.
   */
  probe?: (() => Promise<boolean>) | null;
}

/**
 * Polls settlement reachability on an interval and exposes an on-demand
 * `check()`. Use the periodic value for an offline indicator and `check()` as
 * a blocking pre-flight before handing out a payment QR.
 */
export function useChainConnectivity(options: ChainConnectivityOptions = {}): ChainConnectivity {
  const { intervalMs = 15000, probe = isChainReachable } = options;
  const [isOnline, setIsOnline] = useState(true);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const mounted = useRef(true);

  const check = useCallback(async () => {
    if (!probe) return true;
    setIsChecking(true);
    const reachable = await probe();
    if (mounted.current) {
      setIsOnline(reachable);
      setLastCheckedAt(Date.now());
      setIsChecking(false);
    }
    return reachable;
  }, [probe]);

  useEffect(() => {
    mounted.current = true;
    if (!probe) return;
    void check();
    const id = setInterval(() => void check(), intervalMs);

    // Re-check immediately when the OS network state flips or the app refocuses.
    const onOnline = () => void check();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOnline);

    return () => {
      mounted.current = false;
      clearInterval(id);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOnline);
    };
  }, [check, intervalMs, probe]);

  return { isOnline, isChecking, lastCheckedAt, check };
}
