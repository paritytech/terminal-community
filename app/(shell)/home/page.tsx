"use client";

import Link from "next/link";
import { ClipboardList, Settings, TrendingUp, ReceiptText, Store } from "lucide-react";
import { AmountHero } from "@/components/amount-hero";
import { ScreenHeader } from "@/components/screen-header";
import { iconButtonClass } from "@/components/subpage-header";
import { useTodaysIncome } from "@/lib/storage";
import { FEATURES } from "@/lib/config/features";
import { useMerchantProfile } from "@/lib/config/merchant";
import { formatAmountFromPlanck } from "@/lib/utils/format";
import { PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";

/**
 * Merchant home dashboard. Today's Income is live from sale storage; the
 * action tiles are still placeholders (no navigation yet). The gear in the
 * header opens Settings (no longer a nav tab).
 *
 * Header + amount block share components with Check out so the two tabs line
 * up pixel-for-pixel and nothing shifts when switching between them.
 */
export default function HomePage() {
  const { totalPlanck, isLoading } = useTodaysIncome();
  const symbol = useAssetSymbol();
  // Once onboarding is completed the tile disappears — the profile lives on
  // under Settings → Merchant Profile.
  const merchant = useMerchantProfile();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
        <ScreenHeader
          title="Home"
          action={
            <Link href="/settings" aria-label="Settings" className={`${iconButtonClass} -mr-2`}>
              <Settings className="size-6" />
            </Link>
          }
        />

        {/* Today's income — live sum of today's incoming sales */}
        <section className="px-6 mb-8">
          <AmountHero
            label="Today's Income"
            value={formatAmountFromPlanck(totalPlanck, PUSD_DECIMALS)}
            symbol={symbol}
            testId="todays-income"
            dimmed={isLoading}
          />
        </section>

        {/* Action tiles. Sales works from day one; Reports (X/Z tooling)
            unlocks with the merchant profile. Export CSV and the Become a
            Merchant entry are parked behind FEATURES.becomeMerchant for R1 —
            the export screen itself is untouched and still routable by URL,
            so flipping the flag brings the tile straight back. */}
        <section className="px-6 grid grid-cols-2 gap-4">
          <HomeTile icon={TrendingUp} label="Sales" href="/home/sales" />
          {FEATURES.becomeMerchant && (
            <HomeTile icon={ReceiptText} label="Export CSV" href="/home/export" />
          )}
          {merchant.completed && (
            <HomeTile icon={ClipboardList} label="Reports" href="/home/reports" />
          )}
          {FEATURES.becomeMerchant && !merchant.isLoading && !merchant.completed && (
            <HomeTile icon={Store} label="Become a Merchant" href="/merchant" />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * A destination tile: a container surface with shadow-1 that lifts on hover.
 * The old brand-blue "accent" fill has no token (the system has no chromatic
 * accent unless asked for) — every tile is the same surface now; see the gap
 * register.
 */
function HomeTile({
  icon: Icon,
  label,
  href,
}: {
  icon: typeof TrendingUp;
  label: string;
  href?: string;
}) {
  const className =
    "aspect-square rounded-container p-5 flex flex-col justify-between items-start text-left bg-surface-container shadow-1 hover:bg-selection-container-hover transition active:scale-95";
  const content = (
    <>
      <Icon className="size-6 text-fg-primary" aria-hidden />
      <span className="text-heading-m text-fg-primary">{label}</span>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" className={className}>
      {content}
    </button>
  );
}
