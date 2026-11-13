import { BUSINESS_PROFILE, type BusinessProfile } from "@/lib/config/business";
import type { DailyReport } from "@/lib/hooks/use-bulletin";
import type { PrintDocument, PrintDocumentKind, PrintItem, PrintLine } from "@/lib/host/printing";
import type { ReceiptData } from "./receipt-generator";

function formatMoney(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value.toFixed(2);
}

function formatDate(ts: Date): string {
  const yyyy = ts.getFullYear();
  const mm = String(ts.getMonth() + 1).padStart(2, "0");
  const dd = String(ts.getDate()).padStart(2, "0");
  const hh = String(ts.getHours()).padStart(2, "0");
  const min = String(ts.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function shortRef(value?: string): string {
  return value ? value.slice(-8).toUpperCase() : "--------";
}

function reportIdentityHeader(report: DailyReport): PrintLine[] {
  return [
    ...(report.merchantName ? [{ label: report.merchantName }] : []),
    ...(report.merchantId ? [{ label: "Merchant ID", value: shortRef(report.merchantId) }] : []),
    ...(report.terminalId ? [{ label: "Terminal", value: shortRef(report.terminalId) }] : []),
  ];
}

function businessHeader(business: BusinessProfile): PrintLine[] {
  return [
    { label: business.name },
    ...(business.addressLine1 ? [{ label: business.addressLine1 }] : []),
    ...(business.addressLine2 ? [{ label: business.addressLine2 }] : []),
    ...(business.phone ? [{ label: business.phone }] : []),
  ];
}

export function buildCustomerReceiptPrintDocument(data: ReceiptData, qrValue?: string): PrintDocument {
  const ts = data.timestamp ? new Date(data.timestamp) : new Date();
  const business = data.business ?? BUSINESS_PROFILE;
  const amount = formatMoney(data.amount);
  const asset = data.asset || business.currency;
  const items: PrintItem[] = data.items?.length
    ? data.items.map((item) => ({
        name: item.name,
        quantity: String(item.quantity),
        total: formatMoney(String(Number(item.unitPrice) * item.quantity)),
      }))
    : [{ name: "Amount", quantity: "1", total: amount }];

  // When a tip was added, break the grand total into Subtotal + Tip + Total.
  const hasTip = data.tip != null && Number(data.tip) > 0;
  const totals: PrintLine[] = [
    ...(hasTip
      ? [
          { label: `Subtotal ${asset}`, value: formatMoney(data.subtotal ?? data.amount) },
          { label: `Tip ${asset}`, value: formatMoney(data.tip!) },
        ]
      : []),
    { label: `Total ${asset}`, value: amount },
    { label: `Paid ${asset}`, value: amount },
  ];

  return {
    kind: "CustomerReceipt",
    paperWidth: "Mm58",
    title: "RECORD",
    subtitle: `#${shortRef(data.saleId)}`,
    header: businessHeader(business),
    body: [
      { label: "Date", value: formatDate(ts) },
      ...(data.saleId ? [{ label: "Sale ID", value: shortRef(data.saleId) }] : []),
    ],
    items,
    totals,
    // Same save-receipt deeplink the SVG/download receipt embeds — lets a
    // scanner (or the Polkadot host) rebuild the receipt offline.
    // moduleSize kept small so the QR fits within 58mm paper (no default —
    // the host's default renders too wide and clips at the right margin).
    qr: qrValue ? { data: qrValue, label: "Scan QR in W3SPay", moduleSize: 4 } : undefined,
    footer: [...(data.note?.trim() ? [`Note: ${data.note.trim()}`] : []), "Thank you"],
  };
}

export function buildReportPrintDocument(report: DailyReport, kind: Extract<PrintDocumentKind, "XReport" | "ZReport">): PrintDocument {
  const title = kind === "ZReport" ? "Z REPORT" : "X REPORT";
  const finishedTotal = report.transactions.reduce((sum, tx) => {
    if (tx.status !== "Finished") return sum;
    const value = Number(tx.amountFormatted);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const refundedTotal = report.transactions.reduce((sum, tx) => {
    if (tx.status !== "Refunded") return sum;
    const value = Number(tx.amountFormatted);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const netTotal = finishedTotal - refundedTotal;
  // Total tips across all (non-refunded) receipts in the period.
  const tipsTotal = report.transactions.reduce((sum, tx) => {
    if (tx.status === "Refunded") return sum;
    const value = Number(tx.tip);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  // Items subtotal = everything minus the tips portion. Receipt-style breakdown:
  // Subtotal (items) + Tips = Total (Gross), then Net after any refunds.
  const itemsSubtotal = finishedTotal - tipsTotal;
  const asset = report.transactions[0]?.asset ?? "";
  const finished = report.transactions.filter((tx) => tx.status === "Finished").length;
  const refunded = report.transactions.filter((tx) => tx.status === "Refunded").length;
  const sortedTransactions = [...report.transactions].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const firstSale = sortedTransactions[0]?.saleId;
  const lastSale = sortedTransactions.at(-1)?.saleId;
  const itemSummary = buildReportItemSummary(report);

  return {
    kind,
    paperWidth: "Mm58",
    title,
    subtitle: kind === "ZReport" ? "Closed day" : "Interim snapshot",
    header: reportIdentityHeader(report),
    body: [
      { label: "Date", value: report.selectedDate },
      ...(report.periodLabel ? [{ label: "Period", value: report.periodLabel }] : []),
      { label: "Status", value: kind === "ZReport" || report.dayFinalized ? "Closed" : "Open" },
      { label: "Transactions", value: String(report.totalTransactions) },
      { label: "Finished", value: String(finished) },
      { label: "Refunded", value: String(refunded) },
      ...(firstSale ? [{ label: "First record", value: shortRef(firstSale) }] : []),
      ...(lastSale ? [{ label: "Last record", value: shortRef(lastSale) }] : []),
    ],
    // Print every distinct item — the list length is the item count itself, no
    // fixed cap. A fiscal report must show the full itemized breakdown.
    items: itemSummary,
    // Receipt-style breakdown: Subtotal (items) + Tips = Total, mirroring the
    // customer receipt. Refunds (when any) net down the Total.
    totals: [
      { label: `Subtotal ${asset}`.trim(), value: formatMoney(String(itemsSubtotal)) },
      ...(tipsTotal > 0 ? [{ label: `Tips ${asset}`.trim(), value: formatMoney(String(tipsTotal)) }] : []),
      ...(refundedTotal > 0 ? [{ label: `Refunds ${asset}`.trim(), value: `-${formatMoney(String(refundedTotal))}` }] : []),
      { label: `Total ${asset}`.trim(), value: formatMoney(String(netTotal)) },
    ],
    footer: [],
  };
}

function buildReportItemSummary(report: DailyReport): PrintItem[] {
  const summary = new Map<string, { quantity: number; total: number }>();

  for (const tx of report.transactions) {
    const sign = tx.status === "Refunded" ? -1 : 1;
    if (tx.items?.length) {
      for (const item of tx.items) {
        const current = summary.get(item.name) ?? { quantity: 0, total: 0 };
        const unitPrice = Number(item.unitPrice);
        current.quantity += sign * item.quantity;
        current.total += sign * (Number.isFinite(unitPrice) ? unitPrice * item.quantity : 0);
        summary.set(item.name, current);
      }
    } else {
      const current = summary.get("Manual amount") ?? { quantity: 0, total: 0 };
      const amount = Number(tx.amountFormatted);
      current.quantity += sign;
      current.total += sign * (Number.isFinite(amount) ? amount : 0);
      summary.set("Manual amount", current);
    }
  }

  return [...summary.entries()]
    .sort(([, a], [, b]) => Math.abs(b.total) - Math.abs(a.total))
    .map(([name, value]) => ({
      name,
      quantity: String(value.quantity),
      total: formatMoney(String(value.total)),
    }));
}
