"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Briefcase,
  Bug,
  ChevronRight,
  Coins,
  Info,
  Palette,
  ReceiptText,
  Shapes,
  Store,
  UserRound,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AppearanceChoice, useAppearance } from "@/lib/config/appearance";
import { FEATURES } from "@/lib/config/features";
import { useMerchantProfile } from "@/lib/config/merchant";
import { THEMES, THEME_LABELS } from "@/theme/theme";

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

// Rows sit on the bare page surface, where the selection-hover token is the
// page colour on the light themes — so a row hovers to the container step.
const ROW_CLASS =
  "flex items-center gap-4 py-4 px-2 -mx-2 rounded-medium hover:bg-surface-container transition-colors";

export default function SettingsPage() {
  const merchant = useMerchantProfile();
  const [appearance, setAppearance] = useAppearance();

  // Private use gets the bare menu; the full merchant menu (profile, receipt,
  // report storage) unlocks with a completed onboarding.
  const rows = merchant.completed ? MERCHANT_ROWS : BASE_ROWS;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link
            href="/home"
            className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
            aria-label="Back to home"
          >
            <ArrowLeft className="size-6" />
          </Link>
          <span className="text-heading-l text-fg-primary">Settings</span>
          <div className="size-10" aria-hidden />
        </header>

        <main className="flex-1 min-h-0 px-6 py-4 overflow-auto">
          {/* Flat rows */}
          <div className="space-y-1">
            {rows.map((row) => {
              const Icon = row.icon;
              const content = (
                <>
                  <Icon className="size-6 text-fg-primary shrink-0" aria-hidden />
                  <span className="flex-1 text-label-l text-fg-primary text-left">
                    {row.title}
                  </span>
                  <ChevronRight className="size-5 text-fg-tertiary shrink-0" aria-hidden />
                </>
              );
              return row.href ? (
                <Link key={row.title} href={row.href} className={ROW_CLASS}>
                  {content}
                </Link>
              ) : (
                <button key={row.title} type="button" className={`w-full ${ROW_CLASS}`}>
                  {content}
                </button>
              );
            })}

            {/* Appearance — a dropdown, per the design system (never a row of
                every theme as buttons). "Follow Polkadot app" hands the choice
                back to the host; any theme picked here overrides the host until
                then. See lib/config/appearance.ts. */}
            <div className="flex items-center gap-4 py-4 px-2 -mx-2">
              <Palette className="size-6 text-fg-primary shrink-0" aria-hidden />
              <Label htmlFor="appearance" className="flex-1 text-label-l text-fg-primary">
                Appearance
              </Label>
              <Select
                value={appearance}
                onValueChange={(value) => setAppearance(value as AppearanceChoice)}
              >
                <SelectTrigger
                  id="appearance"
                  aria-label="Appearance"
                  className="w-fit text-label-m"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="auto">Follow Polkadot app</SelectItem>
                  {THEMES.map((theme) => (
                    <SelectItem key={theme} value={theme}>
                      {THEME_LABELS[theme]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {merchant.completed ? (
            /* Onboarded: multi-terminal upsell (placeholder — Back Office
               sync for several terminals isn't built yet) */
            <button
              type="button"
              className="w-full mt-6 flex items-center gap-4 bg-surface-container hover:bg-selection-container-hover rounded-container p-5 text-left transition-colors"
            >
              <Briefcase className="size-6 text-fg-primary shrink-0" aria-hidden />
              <span className="flex-1 min-w-0">
                <span className="block text-label-l text-fg-primary">
                  Need more sales points?
                </span>
                <span className="block text-body-m text-fg-secondary mt-0.5">
                  Connect Back Office to sync data and manage several terminals
                </span>
              </span>
              <ChevronRight className="size-5 text-fg-tertiary shrink-0" aria-hidden />
            </button>
          ) : FEATURES.becomeMerchant ? (
            /* Not onboarded yet: entry into the Become a Merchant flow
               (parked behind the feature flag for R1) */
            <Link
              href="/merchant"
              className="w-full mt-6 flex items-center gap-4 bg-surface-container hover:bg-selection-container-hover rounded-container p-5 text-left transition-colors"
            >
              <Store className="size-6 text-fg-primary shrink-0" aria-hidden />
              <span className="flex-1 min-w-0">
                <span className="block text-label-l text-fg-primary">Become a Merchant</span>
                <span className="block text-body-m text-fg-secondary mt-0.5">
                  Set up a profile to unlock items, reports, and terminal security
                </span>
              </span>
              <ChevronRight className="size-5 text-fg-tertiary shrink-0" aria-hidden />
            </Link>
          ) : null}
        </main>
      </div>
    </div>
  );
}
