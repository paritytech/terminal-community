"use client";

import Image from "next/image";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "@/lib/web3";
import { journeyTracker } from "@/lib/telemetry";
import { HostConnectionHint } from "@/components/host-connection-status";

export default function Home() {
  const router = useRouter();
  const { account } = useAccount();

  // page-load journey: measures from first render to "account resolved".
  // Useful baseline for host-resolve and web3 wiring latency.
  useEffect(() => {
    if (!journeyTracker.isActive("page-load")) {
      journeyTracker.start("page-load", { "journey.route": "/" });
    }
  }, []);

  // There's no landing/splash step anymore. Inside the host the account is
  // auto-detected (lib/web3/components/providers/web3-provider.tsx →
  // HostAutoConnect); once it resolves the terminal is configured, so we go
  // straight to Check out — the amount keypad is the first thing a merchant
  // sees, taking a payment is one tap away. `replace` keeps `/` out of history
  // so the back button doesn't bounce the merchant onto a dead landing page.
  useEffect(() => {
    if (account) {
      journeyTracker.milestone("page-load", "account-resolved");
      journeyTracker.complete("page-load");
      router.replace("/terminal");
    }
  }, [account, router]);

  // Until the host connection resolves we can't route anywhere useful, so we
  // show a minimal connecting state — and, if the auto-connect gives up, the
  // reason plus a Retry (components/host-connection-status.tsx). Page surface
  // comes from the theme (body is bg-surface-main). The wordmark is set in the
  // display style — Manrope, the system's display face.
  return (
    <div className="min-h-dvh flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* Polkadot Logo */}
        <div className="mb-8">
          <Image
            src="/polkadot_logo.jpg"
            alt="Polkadot"
            width={140}
            height={140}
            className="rounded-full"
            priority
          />
        </div>

        {/* T3RMINAL Branding */}
        <div className="text-center space-y-4 mb-10">
          <h1 data-testid="app-heading" className="text-display-xl text-fg-primary">
            T3RMINAL
          </h1>
          <p className="text-body-l text-fg-secondary">Payment Terminal</p>
        </div>

        <HostConnectionHint size="caption" />
      </main>
    </div>
  );
}
