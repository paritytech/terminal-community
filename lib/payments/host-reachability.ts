/**
 * "Can the host settle a coins sale right now?" — the pre-flight for the
 * coins payment method.
 *
 * Coins never touch the chain from the product: the host claims the
 * customer's cheque (`paymentTopUp`) and reports progress
 * (`subscribeTopUpStatus`). So the right liveness signal is the host's
 * payments bridge, not a direct chain read — the Polkadot phone app does not
 * expose the Paseo People chain to products (`chainSupported` → false) and
 * iOS blocks product-side WebSockets, so `isChainReachable()` there is
 * always "offline" while payments work fine.
 *
 * The probe opens `paymentBalanceSubscribe` and resolves true on the first
 * balance update (hosts push the current balance on subscribe), false on an
 * interrupt or the timeout, and always unsubscribes.
 */

import { createPaymentManager } from "@novasamatech/host-api-wrapper";
import { isInHost } from "@/lib/host/detect";

export interface HostBalanceSubscription {
  unsubscribe: () => void;
  onInterrupt?: (callback: (payload: unknown) => void) => void;
}

export interface HostPaymentsProbeDeps {
  subscribeBalance: (onBalance: () => void) => HostBalanceSubscription;
  inHost?: () => boolean;
  online?: () => boolean;
}

const defaultDeps = (): HostPaymentsProbeDeps => ({
  subscribeBalance: (onBalance) => createPaymentManager().subscribeBalance(() => onBalance()),
  inHost: isInHost,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
});

export async function isHostPaymentsReachable(
  timeoutMs = 6000,
  deps: HostPaymentsProbeDeps = defaultDeps(),
): Promise<boolean> {
  if (deps.online && !deps.online()) return false;
  if (deps.inHost && !deps.inHost()) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let subscription: HostBalanceSubscription | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        subscription?.unsubscribe();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      console.warn("[host-reachability] no balance from the host payments bridge within", timeoutMs, "ms");
      finish(false);
    }, timeoutMs);

    try {
      subscription = deps.subscribeBalance(() => finish(true));
      subscription.onInterrupt?.((payload) => {
        console.warn("[host-reachability] host payments bridge interrupted:", payload);
        finish(false);
      });
      // The host may have answered synchronously, before `subscription` was
      // assigned — make sure a settled probe still releases it.
      if (settled) subscription.unsubscribe();
    } catch (error) {
      console.warn("[host-reachability] host payments bridge unavailable:", error);
      finish(false);
    }
  });
}
