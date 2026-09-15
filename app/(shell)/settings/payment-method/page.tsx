"use client";

/**
 * Payment-method selector.
 *
 * Flips the terminal between the pUSD-on-Asset-Hub flow ("Voucher") and the
 * default W3S real-time Coinage flow ("Coins"). The choice persists in host
 * storage and is read by /terminal to decide which QR + listener to arm.
 */

import { SubpageHeader } from "@/components/subpage-header";
import { usePaymentMethod } from "@/lib/config/payment-method";

export default function PaymentMethodSettingsPage() {
  const { method, setMethod } = usePaymentMethod();
  const isCoins = method === "coins";
  const loading = method === undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader title="Payment Method" backHref="/settings" backLabel="Back to settings" />

        <main className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
          {/* Two-position switch: a container tray, the selected half carries
              the primary action surface and slides between the two. */}
          <div className="bg-surface-container rounded-container p-2 shadow-1">
            <div className="relative grid grid-cols-2">
              <span
                aria-hidden
                className={`absolute top-0 bottom-0 w-1/2 rounded-medium bg-action-primary transition-transform duration-200 ease-out ${
                  isCoins ? "translate-x-full" : "translate-x-0"
                }`}
              />
              <button
                type="button"
                role="switch"
                aria-checked={!isCoins}
                disabled={loading}
                onClick={() => (loading ? undefined : isCoins && setMethod("standard"))}
                className={`relative z-10 py-3 text-label-m transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isCoins ? "text-fg-secondary hover:text-fg-secondary-hover" : "text-fg-primary-inverted"
                }`}
              >
                Voucher
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={isCoins}
                disabled={loading}
                onClick={() => (loading ? undefined : !isCoins && setMethod("coins"))}
                className={`relative z-10 py-3 text-label-m transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isCoins ? "text-fg-primary-inverted" : "text-fg-secondary hover:text-fg-secondary-hover"
                }`}
              >
                Coins
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
