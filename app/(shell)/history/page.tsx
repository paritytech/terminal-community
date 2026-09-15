"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  Download,
  Loader2,
  Printer,
  QrCode,
  ReceiptText,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { ScreenHeader } from "@/components/screen-header";
import { SubpageHeader, iconButtonClass } from "@/components/subpage-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/lib/web3";
import { useSalesHistory, type SaleRecord } from "@/lib/storage";
import { useReceiptGenerator } from "@/lib/hooks/use-receipt-generator";
import { formatMoney } from "@/lib/utils/format";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";
import { isHostPrinterAvailable, printHostDocument } from "@/lib/host/printing";
import { buildCustomerReceiptPrintDocument } from "@/lib/receipts/thermal-print";
import { businessProfileFromAdminPayload } from "@/lib/config/business";
import { mergeMerchantBusinessProfile, useMerchantProfile } from "@/lib/config/merchant";
import { useAdminQrPayload } from "@/lib/config/admin-qr";
import { useTerminalIdentity } from "@/lib/config/terminal";

/**
 * Transaction history: searchable list grouped by day (with per-group
 * totals) → transaction detail (status, itemized breakdown, actions) →
 * receipt view. Rows are titled by Order ID.
 */

export default function HistoryPage() {
  const symbol = useAssetSymbol();
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  const { profile: merchantProfile } = useMerchantProfile();
  const { terminalId } = useTerminalIdentity();
  const { groupedSales, searchTerm, setSearchTerm, isLoading, isEmpty } = useSalesHistory();
  const { generateSvgReceipt, downloadPdfReceipt, buildReceiptQrValue } = useReceiptGenerator();
  const [selectedSale, setSelectedSale] = useState<SaleRecord | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showShareQr, setShowShareQr] = useState(false);
  const [svgReceipt, setSvgReceipt] = useState<string | null>(null);
  const [printerAvailable, setPrinterAvailable] = useState(false);
  const [isPrintingReceipt, setIsPrintingReceipt] = useState(false);
  const [printMessage, setPrintMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const businessProfile = mergeMerchantBusinessProfile(
    businessProfileFromAdminPayload(adminPayload),
    merchantProfile,
  );

  useEffect(() => {
    let mounted = true;
    isHostPrinterAvailable().then((available) => {
      if (mounted) setPrinterAvailable(available);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Not connected state
  if (!account) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
            <div className="text-center space-y-3 w-full">
              <h1 className="text-heading-l text-fg-primary">Welcome</h1>
              <p className="text-body-m text-fg-tertiary">Connecting to host…</p>
            </div>
          </main>
        </div>
      </div>
    );
  }

  const receiptDataOf = (sale: SaleRecord) => ({
    amount: sale.amount,
    asset: sale.asset,
    merchant: sale.merchantAddressNormalized ?? sale.merchantAddress,
    business: businessProfile,
    merchantAddress: sale.merchantAddressNormalized ?? sale.merchantAddress,
    customerAddress: sale.customerAddressNormalized ?? sale.customerAddress,
    transactionId: sale.transactionHash || "",
    blockNumber: sale.blockNumber,
    blockHash: sale.blockHash,
    assetId: sale.assetId,
    saleId: sale.saleId,
    terminalId: terminalId ?? undefined,
    // Reprint from history must stamp the original sale time, not "now".
    timestamp: sale.timestamp,
    items: sale.items,
    subtotal: subtotalOf(sale),
    tip: sale.tip,
  });

  const handleViewReceipt = async (sale: SaleRecord) => {
    setShowReceipt(true);
    setPrintMessage(null);
    const svg = await generateSvgReceipt({
      amount: sale.amount,
      asset: sale.asset,
      merchantAddress: sale.merchantAddress,
      customerAddress: sale.customerAddress,
      transactionId: sale.transactionHash || "",
      blockNumber: sale.blockNumber,
      blockHash: sale.blockHash,
      assetId: sale.assetId,
      saleId: sale.saleId,
      items: sale.items,
      subtotal: subtotalOf(sale),
      tip: sale.tip,
    });
    if (svg) setSvgReceipt(svg);
  };

  const handleDownloadReceipt = async (sale: SaleRecord) => {
    await downloadPdfReceipt({
      amount: sale.amount,
      asset: sale.asset,
      merchantAddress: sale.merchantAddress,
      customerAddress: sale.customerAddress,
      transactionId: sale.transactionHash || "",
      blockNumber: sale.blockNumber,
      blockHash: sale.blockHash,
      assetId: sale.assetId,
      saleId: sale.saleId,
      items: sale.items,
      subtotal: subtotalOf(sale),
      tip: sale.tip,
    });
  };

  const handlePrintReceipt = async (sale: SaleRecord) => {
    if (isPrintingReceipt) return;
    setIsPrintingReceipt(true);
    setPrintMessage(null);
    try {
      const receiptData = receiptDataOf(sale);
      await printHostDocument(
        buildCustomerReceiptPrintDocument(receiptData, buildReceiptQrValue(receiptData)),
      );
      setPrintMessage({ tone: "success", text: "Sent to printer." });
    } catch (err) {
      console.error("[Printer] Failed to print history record:", err);
      setPrintMessage({ tone: "error", text: "Printing failed. Check the printer and try again." });
    } finally {
      setIsPrintingReceipt(false);
    }
  };

  /* ── Receipt view ───────────────────────────────────────────── */

  if (selectedSale && showReceipt) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          <SubpageHeader
            title={`Record #${selectedSale.saleId.slice(-4).toUpperCase()}`}
            onBack={() => { setShowReceipt(false); setSvgReceipt(null); setPrintMessage(null); }}
            backLabel="Back to transaction"
            action={
              <button
                onClick={() => handleDownloadReceipt(selectedSale)}
                className={iconButtonClass}
                aria-label="Download receipt"
              >
                <Download className="size-6" />
              </button>
            }
          />

          <main className="flex-1 flex flex-col px-6 py-4 overflow-auto">
            {/* The receipt SVG paints its own paper and ink — only clip its
                corners. The skeleton is a container surface. */}
            {svgReceipt ? (
              <div className="rounded-nested overflow-hidden">
                <div dangerouslySetInnerHTML={{ __html: svgReceipt }} />
              </div>
            ) : (
              <div className="bg-surface-container rounded-nested h-72 animate-pulse" />
            )}

            {printerAvailable && (
              <Button
                variant="secondary"
                onClick={() => handlePrintReceipt(selectedSale)}
                disabled={isPrintingReceipt}
                className="mt-4 w-full h-auto py-3.5 text-label-m"
              >
                {isPrintingReceipt ? (
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                ) : (
                  <Printer className="size-5" aria-hidden />
                )}
                Print
              </Button>
            )}
            {printMessage && (
              <div className={`mt-3 rounded-nested px-3 py-2 text-body-s ${
                printMessage.tone === "success"
                  ? "bg-surface-nested text-fg-success"
                  : "bg-action-error text-fg-error"
              }`}>
                {printMessage.text}
              </div>
            )}
          </main>
        </div>
      </div>
    );
  }

  /* ── Transaction detail ─────────────────────────────────────── */

  if (selectedSale) {
    const sale = selectedSale;
    const when = new Date(sale.timestamp);
    const lineTotal = (unitPrice: string, quantity: number) => {
      const value = Number(unitPrice) * quantity;
      return Number.isFinite(value) ? value.toFixed(2) : unitPrice;
    };
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          <SubpageHeader
            onBack={() => { setSelectedSale(null); setActionNote(null); }}
            backLabel="Back to history"
          />

          <main className="flex-1 flex flex-col px-6 pb-6">
            {/* Status — the success fill is theme-invariant, so its mark is static white */}
            <div className="flex flex-col items-center pb-6">
              <span className="size-14 rounded-full bg-status-success text-fg-static-white flex items-center justify-center mb-3">
                <ArrowDown className="size-6" aria-hidden />
              </span>
              <p className="text-heading-l text-fg-primary">Received</p>
            </div>

            <div className="border-t border-dashed mb-5" />

            {/* Amount + order line */}
            <div className="flex items-baseline justify-between gap-4 mb-1">
              <span className="text-display-xl font-mono text-fg-primary break-all">
                {formatMoney(sale.amount)}
              </span>
              <span className="text-label-l text-fg-secondary shrink-0">{symbol}</span>
            </div>
            <p className="text-body-m text-fg-secondary mb-6">
              Order <span className="font-mono">#{sale.saleId.slice(-4).toUpperCase()}</span>
              {" · "}
              {when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {" · "}
              {when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
            </p>

            {/* Itemized breakdown — rows of paired values: one style per row,
                the figure ranked by its mono face, never by weight */}
            {(sale.items?.length ?? 0) > 0 && (
              <div className="space-y-1.5 pb-4 border-b mb-4">
                {sale.items!.map((item, i) => (
                  <div key={`${item.name}-${i}`} className="flex justify-between gap-4 text-body-m text-fg-secondary">
                    <span>{item.quantity}x {item.name}</span>
                    <span className="font-mono shrink-0">{lineTotal(item.unitPrice, item.quantity)} {symbol}</span>
                  </div>
                ))}
              </div>
            )}
            {sale.tip && subtotalOf(sale) && (
              <div className="space-y-1.5 pb-4 border-b mb-4 text-body-m text-fg-secondary">
                <div className="flex justify-between gap-4">
                  <span>Subtotal</span>
                  <span className="font-mono">{formatMoney(subtotalOf(sale)!)} {symbol}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Tip</span>
                  <span className="font-mono">{formatMoney(sale.tip)} {symbol}</span>
                </div>
              </div>
            )}
            <div className="flex justify-between gap-4 mb-8 text-body-l text-fg-primary">
              <span>Total</span>
              <span className="font-mono">{formatMoney(sale.amount)} {symbol}</span>
            </div>

            {/* Actions — rows on the page surface, so they hover to the
                container step; the destructive one stays quiet at rest */}
            <div className="mb-2 -mx-2">
              <button
                onClick={() => handleViewReceipt(sale)}
                className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-primary hover:bg-surface-container transition-colors"
              >
                <ReceiptText className="size-5" aria-hidden />
                <span>Review Receipt</span>
              </button>
              <button
                onClick={() => setShowShareQr(true)}
                className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-primary hover:bg-surface-container transition-colors"
              >
                <QrCode className="size-5" aria-hidden />
                <span>Share Receipt via QR</span>
              </button>
              <button
                onClick={() => setActionNote("Refunds aren't available yet.")}
                className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-error hover:bg-action-error transition-colors"
              >
                <Undo2 className="size-5" aria-hidden />
                <span>Refund</span>
              </button>
            </div>
            {actionNote && (
              <p className="text-body-s text-fg-error">{actionNote}</p>
            )}
          </main>
        </div>

        {/* Share-receipt QR overlay — a container card over the scrim; the QR
            paints its own white quiet zone so it scans on every theme */}
        {showShareQr && (
          <div className="fixed inset-0 z-50 bg-surface-overlay flex flex-col items-center justify-center px-6">
            <div className="w-full max-w-sm bg-surface-container rounded-container shadow-3 p-6 flex flex-col items-center text-center">
              <p className="text-heading-l text-fg-primary mb-1">Scan QR to Receive Receipt</p>
              <p className="text-body-m text-fg-secondary mb-6">
                Payment Receipt: Order #{sale.saleId.slice(-4).toUpperCase()}
              </p>
              <div className="rounded-container overflow-hidden mb-8">
                <QRCodeSVG value={buildReceiptQrValue(receiptDataOf(sale))} size={272} level="L" marginSize={2} />
              </div>
              <Button
                variant="secondary"
                onClick={() => setShowShareQr(false)}
                className="w-full h-auto py-3.5 text-label-m"
              >
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ── List ───────────────────────────────────────────────────── */

  const groups = Object.entries(groupedSales);
  const searching = searchTerm.trim() !== "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <ScreenHeader title="History" testId="history-header" />

        {/* Search — shadcn Input with the icon and clear control floating in
            its padding; "Cancel" is the quiet escape (ghost, body style) */}
        <div className="px-6 pb-3 shrink-0 flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-tertiary"
              aria-hidden
            />
            <Input
              data-testid="history-search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Type Transaction ID"
              aria-label="Search transactions"
              className="h-11 rounded-full pl-10 pr-10"
            />
            {searching && (
              <button
                onClick={() => setSearchTerm("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-fg-tertiary hover:bg-action-tertiary-hover hover:text-fg-primary transition-colors"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {searching && (
            <Button
              variant="ghost"
              onClick={() => setSearchTerm("")}
              className="shrink-0 text-body-m font-normal"
            >
              Cancel
            </Button>
          )}
        </div>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-6 animate-spin text-fg-tertiary" aria-hidden />
            </div>
          ) : searching && groups.length === 0 ? (
            <p className="text-overline uppercase text-fg-secondary pt-2">
              We haven&apos;t found any matches
            </p>
          ) : isEmpty ? (
            <div className="text-center py-16">
              <h2 data-testid="history-empty" className="text-heading-l text-fg-primary mb-2">
                No Transactions Yet
              </h2>
              <p className="text-body-m text-fg-tertiary">
                Completed sales will show up here.
              </p>
            </div>
          ) : (
            <>
              {searching && (
                <p className="text-overline uppercase text-fg-secondary mb-2">
                  Search result
                </p>
              )}
              {groups.map(([groupLabel, sales]) => {
                const groupTotal = sales.reduce((sum, sale) => {
                  const value = Number(sale.amount);
                  return sum + (Number.isFinite(value) ? value : 0);
                }, 0);
                return (
                  <section key={groupLabel} className="mb-5">
                    {/* Group eyebrow + total: one style, the figure in mono */}
                    {!searching && (
                      <div className="flex justify-between items-baseline mb-1 px-2">
                        <h3 className="text-overline uppercase text-fg-secondary">
                          {groupLabel}
                        </h3>
                        <span className="text-overline font-mono text-fg-secondary">
                          {groupTotal.toFixed(2)} {symbol}
                        </span>
                      </div>
                    )}
                    {/* Rows on the page surface hover to the container step
                        (a list this long has to track under the cursor) */}
                    <div className="-mx-2">
                      {sales.map((sale) => {
                        const time = new Date(sale.timestamp).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        });
                        return (
                          <button
                            key={sale.saleId}
                            onClick={() => setSelectedSale(sale)}
                            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-medium text-left hover:bg-surface-container transition-colors"
                          >
                            <span className="size-11 flex items-center justify-center shrink-0">
                              <ArrowDown className="size-5 text-fg-success" aria-hidden />
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-label-l text-fg-primary">
                                Order #{sale.saleId.slice(-4).toUpperCase()}
                              </span>
                              <span className="block text-body-m text-fg-tertiary">
                                Received · {time}
                              </span>
                            </span>
                            <span className="text-label-l font-mono text-fg-primary shrink-0">
                              {formatMoney(sale.amount)} {symbol}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** Subtotal (items before tip) for a stored sale = amount − tip. Undefined when
 *  there's no tip. */
function subtotalOf(sale: SaleRecord): string | undefined {
  if (!sale.tip) return undefined;
  const sub = Number(sale.amount) - Number(sale.tip);
  return Number.isFinite(sub) ? sub.toFixed(2) : undefined;
}
