"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Briefcase,
  Bug,
  ChevronRight,
  Coins,
  Info,
  ReceiptText,
  Shapes,
  Store,
  UserRound,
} from "lucide-react";
import { FEATURES } from "@/lib/config/features";
import { useMerchantProfile } from "@/lib/config/merchant";

interface SettingsRow {
  /** Route target; rows without one are placeholders for upcoming flows. */
  href?: string;
  icon: typeof Info;
  title: string;
}

/**
 * Rows per the Settings design. Legacy pages that lost their entry here
 * (encryption, on-chain indexing, wallet, export) are still routable by URL —
 * only the menu changed. Payment Method is kept alongside the designed rows.
 */
// Everything here is configured manually and reads from the merchant profile
// — the old back-office/admin-QR binding flow is retired (its page stays
// routable by URL for legacy setups, but has no menu entry).

// Always available — private (pre-merchant) use needs these too.
const BASE_ROWS: SettingsRow[] = [
  { href: "/settings/payment-method", icon: Coins, title: "Payment Method" },
  { href: "/settings/details", icon: Info, title: "Details" },
  { href: "/settings/report-issue", icon: Bug, title: "Help us fix an issue" },
];

// Merchant tooling — unlocked by completing the Become a Merchant flow.
// Report Storage lost its entry — reports now live on Home → Reports.
const MERCHANT_ROWS: SettingsRow[] = [
  { href: "/settings/merchant-profile", icon: UserRound, title: "Merchant Profile" },
  { href: "/settings/receipt", icon: ReceiptText, title: "Receipt" },
  { href: "/settings/items", icon: Shapes, title: "Show Items in Checkout" },
  { href: "/settings/payment-method", icon: Coins, title: "Payment Method" },
  { href: "/settings/details", icon: Info, title: "Details" },
  { href: "/settings/report-issue", icon: Bug, title: "Help us fix an issue" },
];

export default function SettingsPage() {
  const merchant = useMerchantProfile();

  // Private use gets the bare menu; the full merchant menu (profile, receipt,
  // report storage) unlocks with a completed onboarding.
  const rows = merchant.completed ? MERCHANT_ROWS : BASE_ROWS;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/home" className="p-2" aria-label="Back to home">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <span className="text-white text-lg font-semibold">Settings</span>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 px-6 py-4 overflow-auto">
          {/* Flat rows */}
          <div className="space-y-1">
            {rows.map((row) => {
              const Icon = row.icon;
              const content = (
                <>
                  <Icon className="w-6 h-6 text-white shrink-0" />
                  <span className="flex-1 text-white text-lg font-semibold text-left">
                    {row.title}
                  </span>
                  <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
                </>
              );
              return row.href ? (
                <Link
                  key={row.title}
                  href={row.href}
                  className="flex items-center gap-4 py-4 hover:bg-neutral-900 rounded-xl px-2 -mx-2 transition"
                >
                  {content}
                </Link>
              ) : (
                <button
                  key={row.title}
                  type="button"
                  className="w-full flex items-center gap-4 py-4 hover:bg-neutral-900 rounded-xl px-2 -mx-2 transition"
                >
                  {content}
                </button>
              );
            })}
          </div>

          {merchant.completed ? (
            /* Onboarded: multi-terminal upsell (placeholder — Back Office
               sync for several terminals isn't built yet) */
            <button
              type="button"
              className="w-full mt-6 flex items-center gap-4 bg-neutral-900 hover:bg-neutral-800 rounded-2xl p-5 text-left transition"
            >
              <Briefcase className="w-7 h-7 text-white shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-white text-lg font-semibold">
                  Need more sales points?
                </span>
                <span className="block text-neutral-400 text-sm mt-0.5">
                  Connect Back Office to sync data and manage several terminals
                </span>
              </span>
              <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
            </button>
          ) : FEATURES.becomeMerchant ? (
            /* Not onboarded yet: entry into the Become a Merchant flow
               (parked behind the feature flag for R1) */
            <Link
              href="/merchant"
              className="w-full mt-6 flex items-center gap-4 bg-neutral-900 hover:bg-neutral-800 rounded-2xl p-5 text-left transition"
            >
              <Store className="w-7 h-7 text-white shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-white text-lg font-semibold">Become a Merchant</span>
                <span className="block text-neutral-400 text-sm mt-0.5">
                  Set up a profile to unlock items, reports, and terminal security
                </span>
              </span>
              <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
            </Link>
          ) : null}
        </main>
      </div>
    </div>
  );
}
