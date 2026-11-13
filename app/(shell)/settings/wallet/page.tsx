"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Wallet, Copy, Check, Coins } from "lucide-react";
import { useAccount } from "@/lib/web3";
import { AccountAvatar } from "@/lib/web3";
import { useCoinBalance } from "@/lib/payments/coinage/use-coin-balance";
import { formatAmountFromPlanck } from "@/lib/utils/format";
import { PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";

export default function WalletSettingsPage() {
  const { account } = useAccount();
  const { availablePlanck, status: balanceStatus } = useCoinBalance();
  const [copied, setCopied] = useState(false);
  const symbol = useAssetSymbol();

  const balanceLabel =
    availablePlanck != null
      ? `${formatAmountFromPlanck(availablePlanck, PUSD_DECIMALS)} ${symbol}`
      : balanceStatus === "loading" || balanceStatus === "idle"
        ? "Loading…"
        : balanceStatus === "unavailable"
          ? "—"
          : balanceStatus === "error"
            ? "Failed to load"
            : `0 ${symbol}`;

  const handleCopy = () => {
    if (!account) return;
    navigator.clipboard.writeText(account.displayAddress || account.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        <header className="flex items-center px-4 py-4 gap-2">
          <Link href="/settings" className="p-2 text-neutral-400 hover:text-white">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-white" />
            <span className="text-white font-medium">Wallet</span>
          </div>
        </header>

        <main className="flex-1 min-h-0 px-6 py-4 space-y-4 overflow-auto">
          {account ? (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-3">
                <AccountAvatar address={account.address} size={48} className="rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-white font-medium truncate">{account.name}</p>
                  <p className="text-neutral-500 text-xs">Connected via Polkadot host</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-neutral-400 text-xs uppercase tracking-wide">Coin balance</p>
                <div className="flex items-center gap-3 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-3">
                  <div className="w-9 h-9 rounded-lg bg-neutral-800 flex items-center justify-center shrink-0">
                    <Coins className="w-4 h-4 text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p data-testid="wallet-balance" className="text-white font-semibold text-lg leading-tight truncate">
                      {balanceLabel}
                    </p>
                    <p className="text-neutral-500 text-xs">
                      Live from the host — updates as payments are claimed.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-neutral-400 text-xs uppercase tracking-wide">Address</p>
                <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2.5">
                  <code className="flex-1 text-xs text-neutral-200 font-mono break-all">
                    {account.displayAddress || account.address}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 p-1.5 text-neutral-400 hover:text-white transition"
                    title={copied ? "Copied" : "Copy address"}
                  >
                    {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 text-center text-neutral-500 text-sm">
              No wallet connected. Open T3rminal inside Polkadot Desktop to
              auto-connect.
            </div>
          )}
        </main>
      </div>

    </div>
  );
}
