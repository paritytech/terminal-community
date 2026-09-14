"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
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
              <h1 className="text-2xl font-semibold text-white">Welcome</h1>
              <p className="text-neutral-500 text-sm">Connecting to host…</p>
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
          <header className="flex items-center justify-between px-4 py-4">
            <button
              onClick={() => { setShowReceipt(false); setSvgReceipt(null); setPrintMessage(null); }}
              className="p-2"
              aria-label="Back to transaction"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <span className="text-white font-medium">Record #{selectedSale.saleId.slice(-4).toUpperCase()}</span>
            <button onClick={() => handleDownloadReceipt(selectedSale)} className="p-2" aria-label="Download receipt">
              <Download className="w-6 h-6 text-white" />
            </button>
          </header>

          <main className="flex-1 flex flex-col px-6 py-4 overflow-auto">
            {svgReceipt ? (
              <div className="bg-white rounded-xl p-4 overflow-hidden">
                <div dangerouslySetInnerHTML={{ __html: svgReceipt }} />
              </div>
            ) : (
              <div className="bg-white rounded-xl h-72 animate-pulse" />
            )}

            {printerAvailable && (
              <button
                onClick={() => handlePrintReceipt(selectedSale)}
                disabled={isPrintingReceipt}
                className="mt-4 w-full bg-neutral-800 hover:bg-neutral-700 text-white font-medium py-3.5 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isPrintingReceipt ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
                Print
              </button>
            )}
            {printMessage && (
              <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                printMessage.tone === "success"
                  ? "bg-green-900/30 border-green-800 text-green-400"
                  : "bg-red-900/30 border-red-800 text-red-400"
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
          <header className="flex items-center px-4 py-4">
            <button
              onClick={() => { setSelectedSale(null); setActionNote(null); }}
              className="p-2"
              aria-label="Back to history"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
          </header>

          <main className="flex-1 flex flex-col px-6 pb-6">
            {/* Status */}
            <div className="flex flex-col items-center pb-6">
              <span className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center mb-3">
                <ArrowDown className="w-7 h-7 text-white" />
              </span>
              <p className="text-white text-xl font-semibold">Received</p>
            </div>

            <div className="border-t border-dashed border-neutral-800 mb-5" />

            {/* Amount + order line */}
            <div className="flex items-baseline justify-between gap-4 mb-1">
              <span className="text-white text-5xl font-bold tracking-tight break-all">
                {formatMoney(sale.amount)}
              </span>
              <span className="text-neutral-400 text-base font-semibold shrink-0">{symbol}</span>
            </div>
            <p className="text-neutral-400 text-sm mb-6">
              Order <span className="font-mono">#{sale.saleId.slice(-4).toUpperCase()}</span>
              {" · "}
              {when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {" · "}
              {when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
            </p>

            {/* Itemized breakdown */}
            {(sale.items?.length ?? 0) > 0 && (
              <div className="space-y-1.5 pb-4 border-b border-neutral-800 mb-4">
                {sale.items!.map((item, i) => (
                  <div key={`${item.name}-${i}`} className="flex justify-between text-sm">
                    <span className="text-neutral-300">{item.quantity}x {item.name}</span>
                    <span className="text-neutral-300">{lineTotal(item.unitPrice, item.quantity)} {symbol}</span>
                  </div>
                ))}
              </div>
            )}
            {sale.tip && subtotalOf(sale) && (
              <div className="space-y-1.5 pb-4 border-b border-neutral-800 mb-4 text-sm">
                <div className="flex justify-between text-neutral-400">
                  <span>Subtotal</span>
                  <span>{formatMoney(subtotalOf(sale)!)} {symbol}</span>
                </div>
                <div className="flex justify-between text-neutral-400">
                  <span>Tip</span>
                  <span>{formatMoney(sale.tip)} {symbol}</span>
                </div>
              </div>
            )}
            <div className="flex justify-between mb-8">
              <span className="text-white font-semibold">Total</span>
              <span className="text-white font-bold">{formatMoney(sale.amount)} {symbol}</span>
            </div>

            {/* Actions */}
            <div className="mb-2">
              <button
                onClick={() => handleViewReceipt(sale)}
                className="w-full flex items-center gap-3 py-3 text-white hover:text-neutral-300 transition"
              >
                <ReceiptText className="w-5 h-5" />
                <span className="font-medium">Review Receipt</span>
              </button>
              <button
                onClick={() => setShowShareQr(true)}
                className="w-full flex items-center gap-3 py-3 text-white hover:text-neutral-300 transition"
              >
                <QrCode className="w-5 h-5" />
                <span className="font-medium">Share Receipt via QR</span>
              </button>
              <button
                onClick={() => setActionNote("Refunds aren't available yet.")}
                className="w-full flex items-center gap-3 py-3 text-red-500 hover:text-red-400 transition"
              >
                <Undo2 className="w-5 h-5" />
                <span className="font-medium">Refund</span>
              </button>
            </div>
            {actionNote && (
              <p className="text-red-400 text-xs">{actionNote}</p>
            )}
          </main>
        </div>

        {/* Share-receipt QR overlay */}
        {showShareQr && (
          <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center px-6">
            <p className="text-white text-xl font-semibold mb-1">Scan QR to Receive Receipt</p>
            <p className="text-neutral-400 text-sm mb-6">
              Payment Receipt: Order #{sale.saleId.slice(-4).toUpperCase()}
            </p>
            <div className="bg-white rounded-3xl p-6 mb-8">
              <QRCodeSVG value={buildReceiptQrValue(receiptDataOf(sale))} size={240} level="L" />
            </div>
            <button
              onClick={() => setShowShareQr(false)}
              className="w-full max-w-xs bg-neutral-800 hover:bg-neutral-700 text-white font-medium py-3.5 rounded-xl transition"
            >
              Back
            </button>
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

        {/* Search */}
        <div className="px-6 pb-3 shrink-0 flex items-center gap-3">
          <div className="flex-1 flex items-center gap-2 bg-neutral-900 rounded-full px-4 py-2.5">
            <Search className="w-4 h-4 text-neutral-500 shrink-0" />
            <input
              data-testid="history-search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Type Transaction ID"
              className="w-full bg-transparent text-white text-sm outline-none placeholder:text-neutral-500"
            />
            {searching && (
              <button onClick={() => setSearchTerm("")} aria-label="Clear search" className="shrink-0">
                <X className="w-4 h-4 text-neutral-400" />
              </button>
            )}
          </div>
          {searching && (
            <button
              onClick={() => setSearchTerm("")}
              className="text-white text-sm font-medium shrink-0"
            >
              Cancel
            </button>
          )}
        </div>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-neutral-600" />
            </div>
          ) : searching && groups.length === 0 ? (
            <p className="text-neutral-400 text-xs font-semibold tracking-widest pt-2">
              WE HAVEN&apos;T FOUND ANY MATCHES
            </p>
          ) : isEmpty ? (
            <div className="text-center py-16">
              <h2 data-testid="history-empty" className="text-xl font-semibold text-white mb-2">
                No Transactions Yet
              </h2>
              <p className="text-neutral-500 text-sm">
                Completed sales will show up here.
              </p>
            </div>
          ) : (
            <>
              {searching && (
                <p className="text-neutral-400 text-xs font-semibold tracking-widest mb-2">
                  SEARCH RESULT
                </p>
              )}
              {groups.map(([groupLabel, sales]) => {
                const groupTotal = sales.reduce((sum, sale) => {
                  const value = Number(sale.amount);
                  return sum + (Number.isFinite(value) ? value : 0);
                }, 0);
                return (
                  <section key={groupLabel} className="mb-5">
                    {!searching && (
                      <div className="flex justify-between items-baseline mb-1">
                        <h3 className="text-neutral-400 text-xs font-semibold tracking-widest">
                          {groupLabel}
                        </h3>
                        <span className="text-neutral-400 text-xs font-semibold">
                          {groupTotal.toFixed(2)} {symbol}
                        </span>
                      </div>
                    )}
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
                          className="w-full flex items-center gap-3 py-2.5 text-left"
                        >
                          <span className="w-11 h-11 rounded-full bg-green-950 flex items-center justify-center shrink-0">
                            <ArrowDown className="w-5 h-5 text-green-500" />
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-white font-semibold">
                              Order #{sale.saleId.slice(-4).toUpperCase()}
                            </span>
                            <span className="block text-neutral-500 text-sm">
                              Received · {time}
                            </span>
                          </span>
                          <span className="text-white font-semibold shrink-0">
                            {formatMoney(sale.amount)} {symbol}
                          </span>
                        </button>
                      );
                    })}
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
