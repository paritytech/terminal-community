"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isChainReachable } from "@/lib/payments/chain-reachability";

/**
 * Why the settlement path is not usable. "unsupported" means the host answered
 * and has no payments on this runtime, which needs a different message from
 * "offline" (see lib/payments/host-reachability.ts).
 */
export type UnreachableReason = "offline" | "unsupported";

/** What a probe may return: a plain answer, or the host payments verdict. */
export type ProbeResult = boolean | "reachable" | UnreachableReason;

function normalise(result: ProbeResult): UnreachableReason | null {
  if (result === true || result === "reachable") return null;
  if (result === false) return "offline";
  return result;
}

export interface ChainConnectivity {
  /** Last known reachability of the settlement path (so we can actually settle a sale). */
  isOnline: boolean;
  /** Why it is not reachable, when it is not. */
  unreachableReason: UnreachableReason | null;
  /** A reachability probe is in flight. */
  isChecking: boolean;
  /** Epoch millis of the last completed check, or null before the first. */
  lastCheckedAt: number | null;
  /**
   * Run an immediate check (e.g. right before generating a sale QR). Resolves
   * to null when reachable, otherwise to the reason.
   */
  check: () => Promise<UnreachableReason | null>;
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
  probe?: (() => Promise<ProbeResult>) | null;
}

/**
 * Polls settlement reachability on an interval and exposes an on-demand
 * `check()`. Use the periodic value for an offline indicator and `check()` as
 * a blocking pre-flight before handing out a payment QR.
 */
export function useChainConnectivity(options: ChainConnectivityOptions = {}): ChainConnectivity {
  const { intervalMs = 15000, probe = isChainReachable } = options;
  const [isOnline, setIsOnline] = useState(true);
  const [unreachableReason, setUnreachableReason] = useState<UnreachableReason | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const mounted = useRef(true);

  const check = useCallback(async (): Promise<UnreachableReason | null> => {
    if (!probe) return null;
    setIsChecking(true);
    const reason = normalise(await probe());
    if (mounted.current) {
      setIsOnline(reason === null);
      setUnreachableReason(reason);
      setLastCheckedAt(Date.now());
      setIsChecking(false);
    }
    return reason;
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

  return { isOnline, unreachableReason, isChecking, lastCheckedAt, check };
}
