"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { SubpageHeader } from "@/components/subpage-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTodaysIncome } from "@/lib/storage";
import { useCoinBalance } from "@/lib/payments/coinage/use-coin-balance";
import {
  buildCashOutDeeplink,
  checkCashOutAmount,
  openCashOut,
  parseCashOutInput,
  todaysCashOutPlanck,
  CASH_OUT_MAXIMUM_PLANCK,
  CASH_OUT_MINIMUM_PLANCK,
  CASH_PLANCK_DECIMALS,
  type CashOutCheck,
} from "@/lib/payments/cash-out";
import { captureWarning } from "@/lib/telemetry";
import { formatAmountFromPlanck } from "@/lib/utils/format";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";

type AmountMode = "today" | "custom";

/**
 * Home → Cash out: pick today's sales or type an amount, and hand it to
 * getcash, which sends it out of the purse to a bank, a card or a crypto
 * address (lib/payments/cash-out.ts). The merchant confirms the amount,
 * the destination and the purse payment in getcash; nothing leaves the purse
 * from here. Reached from the Home tile behind FEATURES.cashOut.
 */
export default function CashOutPage() {
  const symbol = useAssetSymbol();
  const { totalPlanck, isLoading } = useTodaysIncome();
  const balance = useCoinBalance();
  const [mode, setMode] = useState<AmountMode>("today");
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const outsideHost = balance.status === "unavailable";
  const balancePlanck = balance.status === "ready" ? balance.availablePlanck : null;
  const todayPlanck = isLoading ? null : todaysCashOutPlanck(totalPlanck, balancePlanck);
  const amountPlanck = mode === "today" ? todayPlanck : parseCashOutInput(draft);
  const check = amountPlanck === null ? null : checkCashOutAmount(amountPlanck, balancePlanck);
  const canContinue = !outsideHost && !opening && amountPlanck !== null && check?.kind === "ok";

  const cash = (planck: bigint) => `${formatAmountFromPlanck(planck, CASH_PLANCK_DECIMALS)} ${symbol}`;
  const balanceLine = outsideHost
    ? null
    : balance.status === "error"
      ? "Your balance couldn't be read."
      : balancePlanck === null
        ? "Reading your balance…"
        : `Balance: ${cash(balancePlanck)}`;
  // What stands between the merchant and Continue, if anything: an error tone
  // for a breach, the secondary tone for "nothing to cash out yet".
  const notice: { text: string; tone: "error" | "info" } | null = openError
    ? { text: openError, tone: "error" }
    : outsideHost
      ? { text: "Open T3rminal in the Polkadot app to cash out.", tone: "info" }
      : check === null
        ? null
        : checkNotice(check, mode, cash, balancePlanck);

  const selectMode = (next: AmountMode) => {
    setMode(next);
    setOpenError(null);
  };

  const handleContinue = async () => {
    if (!canContinue || amountPlanck === null) return;
    setOpening(true);
    setOpenError(null);
    try {
      await openCashOut(buildCashOutDeeplink({ amountPlanck, route: "bank" }));
    } catch (error) {
      captureWarning("cash out: getcash did not open", {
        reason: error instanceof Error ? error.message : String(error),
      });
      setOpenError("getcash didn't open. Try again.");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader title="Cash out" backHref="/home" backLabel="Back to home" />

        <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-6 pb-6">
          <div
            role="radiogroup"
            aria-label="Amount to cash out"
            className="overflow-hidden rounded-container bg-surface-container shadow-1"
          >
            <AmountOption
              label="Today's sales"
              value={todayPlanck === null ? "…" : cash(todayPlanck)}
              selected={mode === "today"}
              onSelect={() => selectMode("today")}
              testId="cash-out-today"
            />
            <AmountOption
              label="Other amount"
              selected={mode === "custom"}
              onSelect={() => selectMode("custom")}
              testId="cash-out-custom"
            />
          </div>

          {mode === "custom" && (
            <div className="mt-5 flex flex-col gap-2">
              <Label htmlFor="cash-out-amount" className="text-label-m text-fg-secondary">
                Amount in {symbol}
              </Label>
              <Input
                id="cash-out-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setOpenError(null);
                }}
                aria-invalid={draft !== "" && amountPlanck === null ? true : undefined}
                className="h-12 font-mono"
                autoFocus
              />
            </div>
          )}

          {balanceLine && <p className="mt-4 text-body-m text-fg-secondary">{balanceLine}</p>}
          {notice && (
            <p
              data-testid="cash-out-notice"
              className={`mt-2 text-body-m ${notice.tone === "error" ? "text-fg-error" : "text-fg-secondary"}`}
            >
              {notice.text}
            </p>
          )}

          <div className="flex-1" />
          <p className="mt-8 text-body-m text-fg-secondary">
            getcash opens with this amount. You choose the bank account and confirm the payout
            there.
          </p>
          {/* The screen's one action, in the bottom slot */}
          <Button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            data-testid="cash-out-continue"
            className="mt-4 w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100"
          >
            {opening ? "Opening getcash…" : "Continue to getcash"}
          </Button>
        </main>
      </div>
    </div>
  );
}

function checkNotice(
  check: CashOutCheck,
  mode: AmountMode,
  cash: (planck: bigint) => string,
  balancePlanck: bigint | null,
): { text: string; tone: "error" | "info" } | null {
  switch (check.kind) {
    case "ok":
      return null;
    case "empty":
      return mode === "today" ? { text: "No sales to cash out yet today.", tone: "info" } : null;
    case "below-minimum":
      return { text: `getcash sends out ${cash(CASH_OUT_MINIMUM_PLANCK)} or more.`, tone: "error" };
    case "above-maximum":
      return { text: `getcash sends out up to ${cash(CASH_OUT_MAXIMUM_PLANCK)} at a time.`, tone: "error" };
    case "above-balance":
      return {
        text: balancePlanck === null ? "That's more than your balance." : `That's more than your balance of ${cash(balancePlanck)}.`,
        tone: "error",
      };
  }
}

/** One row of the amount choice: the whole row is the radio and the hover target. */
function AmountOption({
  label,
  value,
  selected,
  onSelect,
  testId,
}: {
  label: string;
  value?: string;
  selected: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-5 py-4 text-left cursor-pointer transition-colors hover:bg-selection-container-hover"
    >
      <span className="flex-1 text-body-l text-fg-primary">{label}</span>
      {value !== undefined && <span className="text-body-l font-mono text-fg-primary">{value}</span>}
      <Check
        className={`size-5 shrink-0 text-fg-primary ${selected ? "" : "invisible"}`}
        aria-hidden
      />
    </button>
  );
}
