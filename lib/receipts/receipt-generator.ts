/**
 * SVG Receipt Generator — Quittung-style paper receipt with optional itemized
 * lines. Designed to print on a standard 80mm thermal roll equivalent.
 *
 * When `items` are present the record shows the line-by-line breakdown and
 * total. When no
 * items are passed (direct-amount-entry flow) the layout falls back to a
 * compact "amount only" receipt.
 */

import QRCode from "qrcode"
import { BUSINESS_PROFILE, type BusinessProfile } from "@/lib/config/business"
import { saveFile } from "@/lib/utils/save-file"

export interface ReceiptItem {
  /** Display label (e.g. "Espresso") */
  name: string
  quantity: number
  /** Per-unit price formatted in the receipt currency (e.g. "2.50") */
  unitPrice: string
}

export interface ReceiptData {
  amount: string
  asset: string
  merchant: string
  merchantAddress: string
  customerAddress: string
  transactionId: string
  blockNumber?: number
  blockHash?: string
  timestamp?: Date
  assetId?: string
  saleId?: string
  terminalId?: string
  merchantId?: string
  /** Optional itemized breakdown — when present, renders Quittung layout. */
  items?: ReceiptItem[]
  /** Optional business profile override (defaults to BUSINESS_PROFILE). */
  business?: BusinessProfile
  /** Items subtotal (before tip). When a tip is present the receipt breaks the
   *  total into Subtotal + Tip + Total; `amount` stays the grand total. */
  subtotal?: string
  /** Tip amount added on top of the subtotal. Omitted/0 → no tip line. */
  tip?: string
  /** The merchant's note for this sale ("Only visible on your receipt"). */
  note?: string
}

// ── Helpers ───────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatMoney(amount: string): string {
  // Normalize "5", "5.0", "5.50" → "5.00"
  const n = Number(amount)
  if (!Number.isFinite(n)) return amount
  return n.toFixed(2)
}

function formatDateEn(ts: Date): string {
  const dd = String(ts.getDate()).padStart(2, "0")
  const mm = String(ts.getMonth() + 1).padStart(2, "0")
  const yyyy = ts.getFullYear()
  const hh = String(ts.getHours()).padStart(2, "0")
  const min = String(ts.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function shortRef(saleId?: string): string {
  return saleId ? saleId.slice(-4).toUpperCase() : "----"
}

// ── Layout ────────────────────────────────────────────────────

const WIDTH = 320
const LINE = 16 // monospace line height
const FONT_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_DISPLAY = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const MONO_CHAR_WIDTH = 0.62

type RenderRow =
  | { type: "text"; value: string; align?: "left" | "center" | "right"; bold?: boolean; size?: number }
  | { type: "split"; left: string; right: string; bold?: boolean; size?: number }
  | { type: "rule" }
  | { type: "space"; height: number }

function buildRows(data: ReceiptData, business: BusinessProfile, ts: Date): RenderRow[] {
  const rows: RenderRow[] = []
  const asset = data.asset || business.currency

  // Header — business identity, centered
  rows.push({ type: "text", value: business.name, align: "center", bold: true, size: 13 })
  if (business.addressLine1) rows.push({ type: "text", value: business.addressLine1, align: "center", size: 11 })
  if (business.addressLine2) rows.push({ type: "text", value: business.addressLine2, align: "center", size: 11 })
  if (business.phone) rows.push({ type: "text", value: business.phone, align: "center", size: 11 })
  rows.push({ type: "space", height: 10 })
  rows.push({ type: "text", value: "RECORD", align: "center", bold: true, size: 20 })
  rows.push({ type: "space", height: 10 })

  // Meta — visible short record number plus the full sale ID for reconciliation.
  rows.push({ type: "split", left: "Record", right: `#${shortRef(data.saleId)}` })
  rows.push({ type: "split", left: "Date", right: formatDateEn(ts) })
  if (data.saleId) {
    rows.push({ type: "text", value: `Sale ID: ${data.saleId}`, align: "left", size: 10 })
  }
  if (data.terminalId) rows.push({ type: "split", left: "Terminal", right: shortRef(data.terminalId) })
  if (data.merchantId) rows.push({ type: "split", left: "Merchant ID", right: data.merchantId })
  rows.push({ type: "space", height: 4 })
  rows.push({ type: "rule" })

  // Right-aligned asset header above prices.
  rows.push({ type: "text", value: asset, align: "right", bold: true })

  // Items
  if (data.items && data.items.length > 0) {
    for (const item of data.items) {
      const lineTotal = (Number(item.unitPrice) * item.quantity).toFixed(2)
      rows.push({
        type: "split",
        left: `${item.quantity} × ${item.name}`,
        right: formatMoney(lineTotal),
      })
    }
  } else {
    // Direct-amount sale — single line
    rows.push({
      type: "split",
      left: "1 × Amount",
      right: formatMoney(data.amount),
    })
  }

  rows.push({ type: "rule" })
  // When a tip was added, break the grand total into Subtotal + Tip + Total.
  const hasTip = data.tip != null && Number(data.tip) > 0
  if (hasTip) {
    rows.push({ type: "split", left: `Subtotal ${asset}`, right: formatMoney(data.subtotal ?? data.amount) })
    rows.push({ type: "split", left: `Tip ${asset}`, right: formatMoney(data.tip!) })
  }
  rows.push({ type: "split", left: `Total ${asset}`, right: formatMoney(data.amount), bold: true, size: 14 })

  // Payment record totals use the actual transaction asset.
  rows.push({ type: "space", height: 6 })
  rows.push({ type: "split", left: `Paid ${asset}`, right: formatMoney(data.amount) })

  const note = data.note?.trim()
  if (note) {
    rows.push({ type: "space", height: 6 })
    rows.push({ type: "rule" })
    rows.push({ type: "text", value: `Note: ${note}`, align: "left", size: 11 })
  }

  return rows
}

// ── SVG composer ──────────────────────────────────────────────

interface ComposeOptions {
  qrDataUrl?: string
}

function maxMonoChars(width: number, fontSize: number): number {
  return Math.max(4, Math.floor(width / (fontSize * MONO_CHAR_WIDTH)))
}

function wrapText(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value]

  const lines: string[] = []
  const words = value.split(/(\s+)/).filter(Boolean)
  let current = ""

  const pushHardWrapped = (text: string) => {
    for (let i = 0; i < text.length; i += maxChars) {
      lines.push(text.slice(i, i + maxChars))
    }
  }

  for (const word of words) {
    if (/^\s+$/.test(word)) {
      if (current && current.length < maxChars) current += " "
      continue
    }

    if (word.length > maxChars) {
      if (current.trim()) lines.push(current.trimEnd())
      current = ""
      pushHardWrapped(word)
      continue
    }

    const next = current ? `${current}${word}` : word
    if (next.length > maxChars) {
      if (current.trim()) lines.push(current.trimEnd())
      current = word
    } else {
      current = next
    }
  }

  if (current.trim()) lines.push(current.trimEnd())
  return lines.length > 0 ? lines : [value]
}

function splitRowLineCount(r: Extract<RenderRow, { type: "split" }>, innerWidth: number): number {
  const size = r.size ?? 12
  const leftWidth = r.left.length * size * MONO_CHAR_WIDTH
  const rightChars = maxMonoChars(innerWidth - leftWidth - 8, size)
  if (r.right.length <= rightChars) return 1
  return 1 + wrapText(r.right, maxMonoChars(innerWidth, size)).length
}

function textRowLines(r: Extract<RenderRow, { type: "text" }>, innerWidth: number): string[] {
  const size = r.size ?? 12
  return wrapText(r.value, maxMonoChars(innerWidth, size))
}

function composeSvg(rows: RenderRow[], opts: ComposeOptions): string {
  const padding = 24
  const innerWidth = WIDTH - padding * 2

  // Measure pass: compute height
  let y = padding
  for (const r of rows) {
    if (r.type === "space") y += r.height
    else if (r.type === "rule") y += 8
    else if (r.type === "text") y += textRowLines(r, innerWidth).length * LINE
    else y += splitRowLineCount(r, innerWidth) * LINE
  }

  // QR area
  const qrSize = opts.qrDataUrl ? 110 : 0
  const qrPad = opts.qrDataUrl ? 20 : 0
  const totalHeight = y + qrPad + qrSize + padding

  // Render pass
  const elements: string[] = []
  y = padding
  for (const r of rows) {
    if (r.type === "space") {
      y += r.height
      continue
    }
    if (r.type === "rule") {
      y += 4
      elements.push(
        `<line x1="${padding}" y1="${y}" x2="${WIDTH - padding}" y2="${y}" stroke="#999" stroke-width="0.5" stroke-dasharray="2,2"/>`
      )
      y += 4
      continue
    }
    const size = r.type === "text" ? r.size ?? 12 : r.size ?? 12
    const weight = (r.type === "text" || r.type === "split") && r.bold ? "700" : "400"
    const family = r.type === "text" && r.align === "center" ? FONT_DISPLAY : FONT_MONO

    if (r.type === "text") {
      const align = r.align ?? "left"
      const x = align === "center" ? WIDTH / 2 : align === "right" ? WIDTH - padding : padding
      const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start"
      const lines = textRowLines(r, innerWidth)
      lines.forEach((line, index) => {
        elements.push(
          `<text x="${x}" y="${y + index * LINE + size * 0.8}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="#111">${escapeXml(line)}</text>`
        )
      })
      y += lines.length * LINE
    } else {
      // split
      const leftWidth = r.left.length * size * MONO_CHAR_WIDTH
      const rightChars = maxMonoChars(innerWidth - leftWidth - 8, size)
      elements.push(
        `<text x="${padding}" y="${y + size * 0.8}" font-family="${FONT_MONO}" font-size="${size}" font-weight="${weight}" fill="#111">${escapeXml(r.left)}</text>`
      )
      if (r.right.length <= rightChars) {
        elements.push(
          `<text x="${WIDTH - padding}" y="${y + size * 0.8}" font-family="${FONT_MONO}" font-size="${size}" font-weight="${weight}" text-anchor="end" fill="#111">${escapeXml(r.right)}</text>`
        )
        y += LINE
      } else {
        const lines = wrapText(r.right, maxMonoChars(innerWidth, size))
        lines.forEach((line, index) => {
          elements.push(
            `<text x="${WIDTH - padding}" y="${y + (index + 1) * LINE + size * 0.8}" font-family="${FONT_MONO}" font-size="${size}" font-weight="${weight}" text-anchor="end" fill="#111">${escapeXml(line)}</text>`
          )
        })
        y += (1 + lines.length) * LINE
      }
      continue
    }
  }

  // QR
  if (opts.qrDataUrl) {
    const qrX = (WIDTH - qrSize) / 2
    const qrY = y + qrPad
    elements.push(
      `<image x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" href="${opts.qrDataUrl}"/>`
    )
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${WIDTH} ${totalHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
  <rect width="${WIDTH}" height="${totalHeight}" fill="#ffffff"/>
  ${elements.join("\n  ")}
</svg>`
}

// ── Public API ────────────────────────────────────────────────

export function generateReceiptSVG(data: ReceiptData): string {
  const ts = data.timestamp ? new Date(data.timestamp) : new Date()
  const business = data.business ?? BUSINESS_PROFILE
  const rows = buildRows(data, business, ts)
  return composeSvg(rows, {})
}

/**
 * The Pocket Receipts product that takes the
 * receipt QR: the customer scans it with the Polkadot app, the host opens the
 * product at the deeplink's path and query, and the receipt lands in their
 * history and on the product's Pocket card. Set NEXT_PUBLIC_RECEIPT_PRODUCT to
 * point a build at another deployment of it (e.g. a `.testnet` name).
 */
export const SAVE_RECEIPT_DEEPLINK_HOST =
  process.env.NEXT_PUBLIC_RECEIPT_PRODUCT?.trim() || "receipts.paseo"

/** The product route that saves a receipt. A plain path: the product's host
 *  serves its SPA for any extensionless path. */
export const SAVE_RECEIPT_DEEPLINK_PATH = "/r"

/**
 * Build the save-receipt deeplink carried by the receipt QR:
 *
 *   polkadotapp://<host>/r?v=1&id=…&a=…&as=…&c=…&t=…&ts=…
 *     [&bn=…][&a1=…][&a2=…][&tel=…]&i=<name>|<qty>|<unitPrice>[&i=…]
 *     [&bh=…][&bk=…][&m=…][&tp=…]
 *
 * The Polkadot app's scanner routes `polkadotapp://<name>.<tld>/…` to that
 * product (the in-app scanner on iOS accepts only this scheme), rewriting it to
 * https and keeping the path and query. Keys are abbreviated for QR density;
 * each repeated `i` is `name|quantity|unitPrice`. `URLSearchParams` owns the
 * `+`/`%XX` encoding. `id` (saleId) is required by the reader; a sale minted
 * without one yields a QR the app rejects. `c` and `t` are legacy: the reader
 * ignores them.
 */
export function buildReceiptDeeplink(
  data: ReceiptData,
  business: BusinessProfile,
  ts: Date,
  host: string = SAVE_RECEIPT_DEEPLINK_HOST,
): string {
  const params = new URLSearchParams()
  params.set("v", "1")
  if (data.saleId) params.set("id", data.saleId)
  params.set("a", data.amount)
  params.set("as", data.asset)
  params.set("c", business.currency)
  params.set("t", String(business.taxRate))
  params.set("ts", ts.toISOString())
  if (business.name) params.set("bn", business.name)
  if (business.addressLine1) params.set("a1", business.addressLine1)
  if (business.addressLine2) params.set("a2", business.addressLine2)
  if (business.phone) params.set("tel", business.phone)
  for (const item of data.items ?? []) {
    params.append("i", `${item.name}|${item.quantity}|${item.unitPrice}`)
  }
  if (data.blockHash) params.set("bh", data.blockHash)
  if (data.blockNumber != null) params.set("bk", String(data.blockNumber))
  if (data.merchantAddress) params.set("m", data.merchantAddress)
  // Tip rides as a decimal `tp` only when present — `a` is already the grand
  // total (subtotal + tip), so the reader derives the subtotal as `a − tp`.
  if (data.tip != null && Number(data.tip) > 0) params.set("tp", data.tip)
  return `polkadotapp://${host}${SAVE_RECEIPT_DEEPLINK_PATH}?${params.toString()}`
}

export async function generateReceiptSVGWithQR(data: ReceiptData): Promise<string> {
  const ts = data.timestamp ? new Date(data.timestamp) : new Date()
  const business = data.business ?? BUSINESS_PROFILE
  const rows = buildRows(data, business, ts)

  const qrPayload = buildReceiptDeeplink(data, business, ts)

  try {
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 0,
      // L (~7% recovery) trades resilience for capacity — the receipt
      // payload with a long item list comfortably exceeds the M-level
      // ceiling, and the printed QR sits on white paper where damage
      // tolerance isn't load-bearing anyway. Scanners still read fine.
      errorCorrectionLevel: "L",
      color: { dark: "#000000", light: "#ffffff" },
    })
    return composeSvg(rows, { qrDataUrl })
  } catch (error) {
    console.error("[Receipt] QR generation failed, returning receipt without QR:", error)
    return composeSvg(rows, {})
  }
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export async function downloadSVG(svg: string, filename: string = "receipt.svg") {
  await saveFile(filename, new Blob([svg], { type: "image/svg+xml" }))
}
