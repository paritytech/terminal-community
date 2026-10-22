import { useState } from "react";
import { usePdfReceipt } from "./use-pdf-receipt";
import { getTimestampFromSaleId } from "@/lib/utils/sale-id";
import { buildReceiptDeeplink, type ReceiptItem } from "@/lib/receipts/receipt-generator";
import { businessProfileFromAdminPayload } from "@/lib/config/business";
import { mergeMerchantBusinessProfile, useMerchantProfile } from "@/lib/config/merchant";
import { useAdminQrPayload } from "@/lib/config/admin-qr-binding";

export interface ReceiptData {
  amount: string;
  asset: string;
  merchantAddress: string;
  customerAddress: string;
  transactionId: string;
  blockNumber?: number;
  blockHash?: string;
  assetId: string;
  saleId?: string;
  terminalId?: string;
  merchantId?: string;
  /** Optional itemized rows when the sale came from /items */
  items?: ReceiptItem[];
  /** Items subtotal (before tip) — present when the sale carried a tip. */
  subtotal?: string;
  /** Tip amount added on top of the subtotal. */
  tip?: string;
  /** When the sale happened. Wins over the saleId's ULID time, which a coins
   *  sale (a hex payment id) does not have. */
  timestamp?: Date;
}

/**
 * The time a receipt states: the sale's own when the caller has it, else the
 * one encoded in a ULID saleId, else now. Without the first, a coins sale's
 * receipt (and its QR) said whenever it was rendered.
 */
function receiptTimestamp(data: ReceiptData): Date {
  if (data.timestamp) return new Date(data.timestamp);
  return (data.saleId ? getTimestampFromSaleId(data.saleId) : null) ?? new Date();
}

/**
 * Hook that handles receipt generation (SVG with QR and PDF download)
 * Centralizes the try-catch logic and fallback handling
 */
export function useReceiptGenerator() {
  const { generateReceipt, generateSvg, generateSvgWithQR } = usePdfReceipt();
  const adminPayload = useAdminQrPayload();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Merchant profile receipt details (Settings → Receipt / onboarding)
  // override the admin-QR-derived identity field by field — every receipt
  // (SVG, PDF, share QR payload) picks the change up from here.
  const { profile: merchantProfile } = useMerchantProfile();
  const business = mergeMerchantBusinessProfile(
    businessProfileFromAdminPayload(adminPayload),
    merchantProfile,
  );

  /**
   * Generate SVG receipt with embedded QR code
   * Falls back to regular SVG if QR generation fails
   */
  const generateSvgReceipt = async (data: ReceiptData): Promise<string | null> => {
    setIsGenerating(true);
    setError(null);

    const timestamp = receiptTimestamp(data);

    try {
      // Try to generate SVG with QR code
      const svg = await generateSvgWithQR({
        amount: data.amount,
        asset: data.asset,
        merchant: business.name,
        business,
        merchantAddress: data.merchantAddress,
        customerAddress: data.customerAddress,
        transactionId: data.transactionId,
        blockNumber: data.blockNumber,
        blockHash: data.blockHash,
        timestamp,
        assetId: data.assetId,
        saleId: data.saleId,
        terminalId: data.terminalId ?? adminPayload?.terminalId,
        merchantId: data.merchantId ?? adminPayload?.merchantId,
        items: data.items,
        subtotal: data.subtotal,
        tip: data.tip,
      });

      setIsGenerating(false);
      return svg;
    } catch (qrError) {
      console.error("[Receipt Generator] Error generating SVG with QR code:", qrError);

      // Fallback to regular SVG without QR
      try {
        const fallbackSvg = generateSvg({
          amount: data.amount,
          asset: data.asset,
          merchant: business.name,
        business,
          merchantAddress: data.merchantAddress,
          customerAddress: data.customerAddress,
          transactionId: data.transactionId,
          blockNumber: data.blockNumber,
          blockHash: data.blockHash,
          timestamp,
          assetId: data.assetId,
          saleId: data.saleId,
          terminalId: data.terminalId ?? adminPayload?.terminalId,
          merchantId: data.merchantId ?? adminPayload?.merchantId,
          items: data.items,
          subtotal: data.subtotal,
          tip: data.tip,
        });

        setIsGenerating(false);
        return fallbackSvg;
      } catch (fallbackError) {
        console.error("[Receipt Generator] Error generating fallback SVG:", fallbackError);
        setError("Failed to generate receipt");
        setIsGenerating(false);
        return null;
      }
    }
  };

  /**
   * Build the same save-receipt deeplink embedded as the QR on the printed
   * receipt. Sharing this value (rather than a `/receipt/<id>` URL) lets a
   * scanner — or the Polkadot host opening it — rebuild the receipt offline.
   * Timestamped by receiptTimestamp, so it matches the rendered QR.
   */
  const buildReceiptQrValue = (data: ReceiptData): string => {
    const timestamp = receiptTimestamp(data);
    return buildReceiptDeeplink(
      {
        amount: data.amount,
        asset: data.asset,
        merchant: business.name,
        business,
        merchantAddress: data.merchantAddress,
        customerAddress: data.customerAddress,
        transactionId: data.transactionId,
        blockNumber: data.blockNumber,
        blockHash: data.blockHash,
        timestamp,
        assetId: data.assetId,
        saleId: data.saleId,
        terminalId: data.terminalId ?? adminPayload?.terminalId,
        merchantId: data.merchantId ?? adminPayload?.merchantId,
        items: data.items,
        tip: data.tip,
      },
      business,
      timestamp,
    );
  };

  /**
   * Download receipt as PDF
   */
  const downloadPdfReceipt = async (data: ReceiptData): Promise<void> => {
    setIsGenerating(true);
    setError(null);

    const timestamp = receiptTimestamp(data);

    try {
      await generateReceipt({
        amount: data.amount,
        asset: data.asset,
        merchant: business.name,
        business,
        merchantAddress: data.merchantAddress,
        customerAddress: data.customerAddress,
        transactionId: data.transactionId,
        blockNumber: data.blockNumber,
        blockHash: data.blockHash,
        timestamp,
        assetId: data.assetId,
        saleId: data.saleId,
        terminalId: data.terminalId ?? adminPayload?.terminalId,
        merchantId: data.merchantId ?? adminPayload?.merchantId,
        items: data.items,
      });

      setIsGenerating(false);
    } catch (err) {
      console.error("[Receipt Generator] Failed to download PDF receipt:", err);
      setError("Failed to download PDF");
      setIsGenerating(false);
      throw err;
    }
  };

  return {
    generateSvgReceipt,
    buildReceiptQrValue,
    downloadPdfReceipt,
    isGenerating,
    error,
  };
}
