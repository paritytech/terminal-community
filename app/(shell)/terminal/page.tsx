"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  X,
  Loader2,
  Check,
  ChevronDown,
  Download,
  Delete,
  Minus,
  Plus,
  Printer,
  ArrowLeft,
  Hourglass,
  Radio,
  ReceiptText,
  Search,
  ShoppingCart,
  StickyNote,
  TriangleAlert,
  Undo2,
  QrCode,
} from "lucide-react";
import { useNavLock, useNavHidden } from "@/components/nav-lock";
import { AmountHero } from "@/components/amount-hero";
import { ScreenHeader } from "@/components/screen-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FEATURES } from "@/lib/config/features";
import { useAccount } from "@/lib/web3";
import { QRCodeSVG } from "qrcode.react";
import { useQRGenerator } from "@/lib/hooks/use-qr-generator";
import { usePaymentListener, type PaymentDetected, type PartialPayment } from "@/lib/hooks/use-payment-listener";
import { useReceiptGenerator } from "@/lib/hooks/use-receipt-generator";
import { useChainConnectivity } from "@/lib/hooks/use-chain-connectivity";
import { PUSD_ASSET_ID, PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { useAssetSymbol, getAssetSymbol } from "@/lib/utils/asset-metadata";
import { formatAmountFromPlanck, amountToPlanck } from "@/lib/utils/format";
import { useAddSale } from "@/lib/storage";
import { normalizeToAssetHubAddress } from "@/lib/utils/address";
import {
  clearPendingSale,
  readPendingSale,
  type StoredCartLine,
} from "@/lib/items/pending-sale";
import type { ReceiptItem } from "@/lib/receipts/receipt-generator";
import { journeyTracker, captureError, recordPaymentOutcome } from "@/lib/telemetry";
import { useAdminQrPayload } from "@/lib/config/admin-qr";
import { watchForFinalization } from "@/lib/payments/finalization-watcher";
import { usePaymentMethod } from "@/lib/config/payment-method";
import {
  useCoinagePayment,
  type CoinagePaymentResult,
} from "@/lib/payments/coinage";
import { isHostPrinterAvailable, printHostDocument } from "@/lib/host/printing";
import { publishNfcPaymentDeeplink, stopNfcEmitting } from "@/lib/host/nfc";
import { buildCustomerReceiptPrintDocument } from "@/lib/receipts/thermal-print";
import { businessProfileFromAdminPayload } from "@/lib/config/business";
import { mergeMerchantBusinessProfile, useMerchantProfile } from "@/lib/config/merchant";
import { useTerminalIdentity } from "@/lib/config/terminal";
import { useCheckoutItems, type CheckoutItem } from "@/lib/config/checkout-items";

const ASSET_ID_STR = PUSD_ASSET_ID.toString();

// Charge on the amount screen arms the QR directly — there's no review step in
// between (the optional receipt note lives inline on the amount screen).
type TerminalState = "input" | "qr" | "completed" | "receipt" | "share";

// POS-style cents entry: digits fill from the right ("5" → 0.05, "500" → 5.00).
// Hard cap keeps the display sane — 9 digits = 9,999,999.99.
const MAX_AMOUNT_DIGITS = 9;

function centsToDecimal(digits: string): string {
  const cents = BigInt(digits || "0");
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

// One basket row in the Items checkout mode — a catalog item (id = item id)
// or a keypad amount (id = custom-N, one line per add so each keeps its price).
interface CheckoutCartLine {
  id: string;
  name: string;
  pricePlanks: bigint;
  quantity: number;
  isCustom?: boolean;
}

// Whole-number prices render without the ".00" tail on item tiles, per the
// design ("12 USD"); lists and buttons keep the full two decimals.
function tilePrice(planks: bigint): string {
  return formatAmountFromPlanck(planks.toString(), PUSD_DECIMALS).replace(/\.00$/, "");
}
  
export default function TerminalPage() {
  return (
    <Suspense fallback={null}>
      <TerminalPageInner />
    </Suspense>
  );
}

function TerminalPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  // When the merchant has scanned an admin QR, payments are routed to the
  // configured payout address regardless of which wallet is connected.
  // Falls back to the connected account so direct-amount flows still work
  // before an admin binding exists.
  const receivingAddress = adminPayload?.receivingAddress ?? account?.address;
  const { generateSvgReceipt, buildReceiptQrValue, downloadPdfReceipt } = useReceiptGenerator();
  const { addSale } = useAddSale();
  // Business identity on receipts/prints: the merchant profile's receipt
  // details (Settings → Receipt / onboarding) override the admin-QR-derived
  // profile field by field.
  const { profile: merchantProfile } = useMerchantProfile();
  const businessProfile = mergeMerchantBusinessProfile(
    businessProfileFromAdminPayload(adminPayload),
    merchantProfile,
  );
  // This device's terminal identity (Settings → Details) tags receipts,
  // payment deeplinks and telemetry — replaces the retired admin-QR id.
  const { terminalId } = useTerminalIdentity();
  // POS keypad state — a plain digit string interpreted as cents.
  const [amountDigits, setAmountDigits] = useState("");
  // Optional merchant note, typed inline on the amount screen (behind an
  // "Add note" toggle); stored on the sale record and shown on the receipt.
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const enteredAmount = centsToDecimal(amountDigits);
  const hasAmount = amountDigits !== "" && BigInt(amountDigits) > 0n;

  const pressDigit = (d: string) => {
    setAmountDigits((prev) => (prev + d).replace(/^0+/, "").slice(0, MAX_AMOUNT_DIGITS));
  };
  const backspaceDigit = () => {
    setAmountDigits((prev) => prev.slice(0, -1));
  };
  // Payment method (Settings → Payment Method). `coins` swaps the QR + the
  // detection mechanism over to the W3S real-time Coinage flow.
  const { method } = usePaymentMethod();
  const useCoins = method === "coins";
  // Token symbol pulled from on-chain asset metadata (falls back to the
  // bundled default until the chain read resolves).
  const symbol = useAssetSymbol();
  const [terminalState, setTerminalState] = useState<TerminalState>("input");
  const [isGenerating, setIsGenerating] = useState(false);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [paymentReceived, setPaymentReceived] = useState<PaymentDetected | null>(null);
  // Partial credit progress for multi-group offboards: set while the running
  // total is below the requested amount, cleared once the sale completes.
  const [partial, setPartial] = useState<PartialPayment | null>(null);
  // Coins claim that credited less than the cheque asked for (the host will
  // claim no more) — shown on the completed screen next to the recorded amount.
  const [coinsShortfall, setCoinsShortfall] = useState<{ requested: string; credited: string } | null>(null);
  const [svgReceipt, setSvgReceipt] = useState<string | null>(null);
  const [finalAmount, setFinalAmount] = useState<string>("");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [printerAvailable, setPrinterAvailable] = useState(false);
  const [isPrintingReceipt, setIsPrintingReceipt] = useState(false);
  const [printMessage, setPrintMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // Cart lines stashed by /items "Charge" — flow into the printed receipt.
  const [pendingItems, setPendingItems] = useState<StoredCartLine[]>([]);
  // Chain reachability: periodic indicator + a pre-flight gate before issuing a QR.
  const connectivity = useChainConnectivity();
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  // Items checkout mode (Settings → Show Items in Checkout). When enabled the
  // entry screen swaps to the item grid with an in-memory basket; the keypad
  // stays reachable as the "Amount" tab and feeds the basket as Custom Amount
  // lines. Default tab is Items, per the design.
  const checkoutItems = useCheckoutItems();
  const itemsMode = checkoutItems.enabled === true;
  const [activeTab, setActiveTab] = useState<"items" | "amount">("items");
  const [cart, setCart] = useState<CheckoutCartLine[]>([]);
  const [basketOpen, setBasketOpen] = useState(false);
  const [clearCartConfirm, setClearCartConfirm] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  // Monotonic id for Custom Amount lines — each keypad add is its own row.
  const customSeq = useRef(1);
  // Tip carried over from /tips (planck string). Drives the Subtotal/Tip/Total
  // breakdown on the receipt; the QR `amount` already includes it.
  const [tipPlanck, setTipPlanck] = useState<string | null>(null);

  // Preset amount from /items "Charge" flow: ?amount=<plancks>&source=items
  // skips the keypad and jumps straight to the QR screen with that total,
  // and pulls the itemized cart out of sessionStorage so the receipt can
  // render line-by-line later.
  useEffect(() => {
    let mounted = true;
    isHostPrinterAvailable().then((available) => {
      if (mounted) setPrinterAvailable(available);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const amountParam = searchParams.get("amount");
    if (!amountParam || !/^\d+$/.test(amountParam)) return;
    const decimal = formatAmountFromPlanck(amountParam, PUSD_DECIMALS);
    setFinalAmount(decimal);
    setTerminalState("qr");

    if (searchParams.get("source") === "items") {
      const pending = readPendingSale();
      if (pending) {
        setPendingItems(pending.lines);
      }
    }

    const tipParam = searchParams.get("tip");
    if (tipParam && /^\d+$/.test(tipParam)) setTipPlanck(tipParam);

    // Journey starts here — first frame the merchant sees the QR. We measure
    // until the success screen renders (or fail/abandon). Admin identifiers
    // (when bound) are also attached so Sentry traces can be filtered per
    // merchant/terminal.
    if (!journeyTracker.isActive("terminal-payment")) {
      journeyTracker.start("terminal-payment", {
        "journey.amount": decimal,
        "journey.source": searchParams.get("source") ?? "direct",
        "journey.terminal_id": terminalId ?? "unbound",
        "journey.merchant_id": adminPayload?.merchantId ?? "unbound",
      });
    }
    // run once on mount with whatever the URL says
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qrData = finalAmount && receivingAddress ? {
    recipient: receivingAddress,
    amountPlanck: amountToPlanck(finalAmount, PUSD_DECIMALS).toString(),
    terminalId: terminalId ?? undefined,

  } : null;

  const qrValue = useQRGenerator(qrData);

  // Decimal tip + subtotal for the receipt breakdown (only when a tip exists).
  // `finalAmount` is the grand total; subtotal = total − tip.
  const tipDecimal = tipPlanck && /^\d+$/.test(tipPlanck) && BigInt(tipPlanck) > 0n
    ? formatAmountFromPlanck(tipPlanck, PUSD_DECIMALS)
    : undefined;
  const subtotalDecimal = tipDecimal && tipPlanck && finalAmount
    ? formatAmountFromPlanck(
        (amountToPlanck(finalAmount, PUSD_DECIMALS) - BigInt(tipPlanck)).toString(),
        PUSD_DECIMALS,
      )
    : undefined;

  // Mark QR rendered as soon as we have a value to show — useful to split
  // "how fast did we generate the QR" from "how long did the customer take
  // to pay" in the waterfall.
  useEffect(() => {
    if (qrValue) journeyTracker.milestone("terminal-payment", "qr-generated");
  }, [qrValue]);

  // Sale-in-progress: while waiting for the offboard credit to land, the
  // listener is the only thing that can advance state. Locking out new sales
  // (calculator + nav) is the merchant-side counterpart to the QR's
  // lockAmount=true flag.
  const saleInProgress = terminalState === "qr" && !paymentReceived;
  useNavLock(saleInProgress);
  // Full-screen states with no tab bar: the payment QR (every vertical pixel
  // goes to the scannable code) and the share-receipt view.
  useNavHidden(terminalState === "qr" || terminalState === "share");

  // The listener only runs while the QR screen is awaiting payment. After
  // best-block detection we hand off finalization tracking to the singleton
  // in lib/payments/finalization-watcher.ts and tear this subscription down
  // so the merchant can start the next sale immediately. The watcher stamps
  // `finalizedAt` on the sale row when GRANDPA finality lands and history
  // surfaces the indicator.
  const listenerActive = !useCoins && !!receivingAddress && saleInProgress;

  const listenerOptions = listenerActive && receivingAddress ? {
    recipient: receivingAddress,
    // Reconcile incoming credits against the requested total. A multi-group
    // wallet offboard lands as several credits; the listener accumulates them
    // and only fires success once the sum reaches this amount.
    requestedPlanck: finalAmount
      ? amountToPlanck(finalAmount, PUSD_DECIMALS).toString()
      : undefined,
    onPartialPayment: (p: PartialPayment) => {
      console.log("[Terminal] Partial payment:", p.received, "/", p.requested);
      setPartial(p);
      journeyTracker.milestone("terminal-payment", "payment-partial");
    },
    onPaymentDetected: async (payment: PaymentDetected) => {
      console.log("[Terminal] Payment detected!", payment);
      setPartial(null);
      journeyTracker.milestone("terminal-payment", "payment-detected");
      journeyTracker.addAttributes("terminal-payment", {
        "journey.sale_id": payment.saleId,
        "journey.block_number": payment.blockNumber ?? 0,
      });
      setPaymentReceived(payment);
      setSaleId(payment.saleId);

      // Persist the merchant address that actually received the payment —
      // that's the admin-configured payout when an admin payload is bound,
      // or the connected wallet for the standalone flow.
      const normalizedMerchant = normalizeToAssetHubAddress(receivingAddress);
      // Coinage offboard is privacy-preserving — the new "_and_vouchers"
      // pallet call doesn't expose the sender, so the listener gives us
      // the sentinel "anonymous". Skip normalization for that case.
      const normalizedCustomer = payment.from === "anonymous"
        ? "anonymous"
        : normalizeToAssetHubAddress(payment.from);

      // Snapshot cart lines as receipt items — these get persisted on the
      // sale record so a re-print from history shows the same itemized
      // breakdown, and they get included in the daily bulletin report.
      const receiptItems: ReceiptItem[] = pendingItems.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        unitPrice: formatAmountFromPlanck(line.pricePlanks, PUSD_DECIMALS),
      }));

      try {
        await addSale({
          saleId: payment.saleId,
          amount: formatAmountFromPlanck(payment.amount, PUSD_DECIMALS),
          amountPlanck: payment.amount,
          asset: getAssetSymbol(),
          assetId: ASSET_ID_STR,
          merchantAddress: normalizedMerchant,
          customerAddress: normalizedCustomer,
          merchantAddressNormalized: normalizedMerchant,
          customerAddressNormalized: normalizedCustomer,
          transactionHash: payment.blockHash,
          blockNumber: payment.blockNumber,
          blockHash: payment.blockHash,
          timestamp: new Date(),
          type: 'incoming',
          items: receiptItems.length > 0 ? receiptItems : undefined,
          tip: tipDecimal,
          note: note.trim() || undefined,
        });
        journeyTracker.milestone("terminal-payment", "sale-saved");
        console.log("[Terminal] Sale saved to local storage");

        // Hand off finalization tracking to the background watcher. The
        // sale row already exists with `finalizedAt: undefined`; the
        // watcher will stamp it once GRANDPA finality lands. Fire-and-
        // forget: this terminal page can unmount immediately after.
        watchForFinalization(payment.saleId, payment.blockHash);
      } catch (err) {
        console.error("[Terminal] Failed to save sale to local storage:", err);
        captureError(err, { component: "terminal", phase: "save-sale" }, {
          saleId: payment.saleId,
        });
      }

      const svg = await generateSvgReceipt({
        amount: formatAmountFromPlanck(payment.amount, PUSD_DECIMALS),
        asset: getAssetSymbol(),
        merchantAddress: normalizedMerchant,
        customerAddress: normalizedCustomer,
        transactionId: payment.blockHash,
        blockNumber: payment.blockNumber,
        blockHash: payment.blockHash,
        assetId: ASSET_ID_STR,
        saleId: payment.saleId,
        items: receiptItems.length > 0 ? receiptItems : undefined,
        subtotal: subtotalDecimal,
        tip: tipDecimal,
      });

      if (svg) {
        setSvgReceipt(svg);
        journeyTracker.milestone("terminal-payment", "receipt-generated");
      }
      // Sale is closed — drop the stashed cart so it can't leak to the next
      // sale if the merchant returns to /items without re-picking.
      clearPendingSale();
      setTerminalState("completed");
      journeyTracker.complete("terminal-payment");
      recordPaymentOutcome({
        outcome: "success",
        method: "voucher",
        amount: formatAmountFromPlanck(payment.amount, PUSD_DECIMALS),
        source: searchParams.get("source") ?? "direct",
        saleId: payment.saleId,
        terminalId: terminalId ?? undefined,
        merchantId: adminPayload?.merchantId,
      });
    },
  } : null;

  usePaymentListener(listenerOptions);

  // W3S Coinage completion: the host has already moved the bearer coins into
  // the merchant coin set (paymentTopUp Coins) — the claim only resolves once
  // its extrinsics are in-block, and the host owns the submission. There's no
  // public sender and no inclusion block hash to track, so we record the sale
  // against the merchant identity with an "anonymous" customer and stamp it
  // finalized immediately (green check in History) rather than spinning.
  const handleCoinsPaid = async (result: CoinagePaymentResult) => {
    journeyTracker.milestone("terminal-payment", "payment-detected");
    journeyTracker.addAttributes("terminal-payment", {
      "journey.sale_id": result.paymentId,
    });

    const amountPlanck = amountToPlanck(result.amount, PUSD_DECIMALS).toString();
    const normalizedMerchant = receivingAddress
      ? normalizeToAssetHubAddress(receivingAddress)
      : "";

    const payment: PaymentDetected = {
      from: "anonymous",
      to: normalizedMerchant,
      amount: amountPlanck,
      assetId: ASSET_ID_STR,
      blockHash: result.paymentId,
      blockNumber: 0,
      saleId: result.paymentId,
      chain: "paseo-individuality",
    };
    setPaymentReceived(payment);
    setSaleId(result.paymentId);
    setCoinsShortfall(
      result.partial ? { requested: result.requestedAmount, credited: result.amount } : null,
    );

    const receiptItems: ReceiptItem[] = pendingItems.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPrice: formatAmountFromPlanck(line.pricePlanks, PUSD_DECIMALS),
    }));

    try {
      await addSale({
        saleId: result.paymentId,
        amount: result.amount,
        amountPlanck,
        asset: getAssetSymbol(),
        assetId: ASSET_ID_STR,
        merchantAddress: normalizedMerchant,
        customerAddress: "anonymous",
        merchantAddressNormalized: normalizedMerchant,
        customerAddressNormalized: "anonymous",
        transactionHash: result.paymentId,
        blockNumber: 0,
        blockHash: result.paymentId,
        timestamp: new Date(),
        // Coin claims confirm on the spot — the host already moved the coins
        // in-block. Stamp finalized now so History shows the green check
        // immediately (no finality spinner, unlike the standard pUSD flow).
        finalizedAt: new Date(),
        type: "incoming",
        items: receiptItems.length > 0 ? receiptItems : undefined,
        tip: tipDecimal,
        note: note.trim() || undefined,
      });
      journeyTracker.milestone("terminal-payment", "sale-saved");
    } catch (err) {
      console.error("[Terminal] Failed to save coins sale:", err);
      captureError(err, { component: "terminal", phase: "save-sale-coins" }, {
        saleId: result.paymentId,
      });
    }

    const svg = await generateSvgReceipt({
      amount: result.amount,
      asset: getAssetSymbol(),
      merchantAddress: normalizedMerchant,
      customerAddress: "anonymous",
      transactionId: result.paymentId,
      blockNumber: 0,
      blockHash: result.paymentId,
      assetId: ASSET_ID_STR,
      saleId: result.paymentId,
      items: receiptItems.length > 0 ? receiptItems : undefined,
      subtotal: subtotalDecimal,
      tip: tipDecimal,
    });
    if (svg) {
      setSvgReceipt(svg);
      journeyTracker.milestone("terminal-payment", "receipt-generated");
    }

    clearPendingSale();
    setTerminalState("completed");
    journeyTracker.complete("terminal-payment");
    recordPaymentOutcome({
      outcome: "success",
      method: "coins",
      amount: result.amount,
      source: searchParams.get("source") ?? "direct",
      saleId: result.paymentId,
      terminalId: terminalId ?? undefined,
      merchantId: adminPayload?.merchantId,
    });
  };

  const coinage = useCoinagePayment(
    useCoins && saleInProgress
      ? {
          active: true,
          amount: finalAmount,
          onPaid: (result) => {
            void handleCoinsPaid(result);
          },
        }
      : null,
  );

  // The QR screen shows the Coinage deeplink when the coins method is active,
  // otherwise the standard pUSD payload.
  const displayQrValue = useCoins ? coinage.qrValue : qrValue;

  // For the coins path the deeplink QR comes from the coinage hook, not the
  // standard qrValue — track when it's ready so the journey waterfall captures
  // QR-armed time for both payment methods.
  useEffect(() => {
    if (useCoins && coinage.qrValue) journeyTracker.milestone("terminal-payment", "qr-generated");
  }, [useCoins, coinage.qrValue]);

  // Coins flow failure: the host's claim/top-up can error out (decrypt,
  // codec, or chain trouble). The voucher flow has no comparable terminal
  // failure — a missing payment is an abandon, not a failure — so this is the
  // only place we record a payment.outcome=failure. Fires once per transition
  // into the error state.
  useEffect(() => {
    if (!useCoins || coinage.status !== "error") return;
    recordPaymentOutcome({
      outcome: "failure",
      method: "coins",
      amount: finalAmount,
      source: searchParams.get("source") ?? "direct",
      terminalId: terminalId ?? undefined,
      merchantId: adminPayload?.merchantId,
      reason: coinage.error ?? "coinage_error",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCoins, coinage.status]);

  useEffect(() => {
    const paymentIncoming =
      paymentReceived ||
      partial ||
      (useCoins && (coinage.status === "claiming" || coinage.status === "paid"));
    if (paymentIncoming) setShowCancelModal(false);
  }, [coinage.status, partial, paymentReceived, useCoins]);

  // Mirror the on-screen payment QR onto the host NFC tag (HCE) when the host
  // exposes one, so a customer can tap-to-pay instead of scanning. Same deeplink
  // as the QR (payment only — never the receipt). Emits only while the QR is
  // actually presented; cleared the moment a payment starts arriving, the sale
  // ends, the deeplink changes, or we unmount. No-ops when the host has no NFC.
  // Parked behind FEATURES.nfcTapToPay for R1 — off means nothing is emitted
  // and the banner doesn't mention NFC.
  const paymentQrLive =
    saleInProgress &&
    !!displayQrValue &&
    !paymentReceived &&
    !partial &&
    !(useCoins && (coinage.status === "claiming" || coinage.status === "paid"));

  useEffect(() => {
    if (!FEATURES.nfcTapToPay || !paymentQrLive || !displayQrValue) return;
    void publishNfcPaymentDeeplink(displayQrValue).catch((err) => {
      console.warn("[NFC] payment deeplink publish failed:", err);
    });
    return () => {
      void stopNfcEmitting();
    };
  }, [paymentQrLive, displayQrValue]);

  // ——— Items-mode basket ———
  const cartTotalPlanks = cart.reduce(
    (sum, line) => sum + line.pricePlanks * BigInt(line.quantity),
    0n,
  );
  const cartCount = cart.reduce((n, line) => n + line.quantity, 0);
  const cartTotalDecimal = formatAmountFromPlanck(cartTotalPlanks.toString(), PUSD_DECIMALS);

  // Tapping a tile adds one; repeat taps merge into the same line.
  const addCatalogItem = (item: CheckoutItem) => {
    const pricePlanks = amountToPlanck(item.price, PUSD_DECIMALS);
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.id === item.id);
      if (idx === -1) {
        return [...prev, { id: item.id, name: item.name, pricePlanks, quantity: 1 }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
      return next;
    });
  };

  // Amount tab in items mode: the keypad amount lands in the basket as its
  // own "Custom Amount" line, then the view flips back to the item grid.
  const addCustomAmount = () => {
    if (!hasAmount) return;
    const pricePlanks = amountToPlanck(enteredAmount, PUSD_DECIMALS);
    setCart((prev) => [
      ...prev,
      {
        id: `custom-${customSeq.current++}`,
        name: "Custom Amount",
        pricePlanks,
        quantity: 1,
        isCustom: true,
      },
    ]);
    setAmountDigits("");
    setActiveTab("items");
  };

  const changeCartQuantity = (id: string, delta: number) => {
    setCart((prev) => {
      const next = prev
        .map((l) => (l.id === id ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0);
      if (next.length === 0) setBasketOpen(false);
      return next;
    });
  };

  const clearCart = () => {
    setCart([]);
    setClearCartConfirm(false);
    setBasketOpen(false);
  };

  // Arm the payment QR for `amountDecimal`. Nothing on-chain happens yet. The
  // amber "Generating Payment" banner covers the connectivity pre-flight
  // (isGenerating) and the QR value computation. Takes the amount explicitly
  // (rather than reading `enteredAmount`) because the basket path sets the
  // keypad digits in the same tick it calls this.
  const startPayment = async (amountDecimal: string) => {
    if (!account) return;

    setConnectivityError(null);
    setIsGenerating(true);
    setTerminalState("qr");

    // Don't hand the customer a QR we can't settle — confirm the chain is
    // reachable right now before showing it.
    const reachable = await connectivity.check();
    if (!reachable) {
      setIsGenerating(false);
      setTerminalState("input");
      // Items mode got here with keypad digits derived from the basket — drop
      // them so the Amount tab comes back clean; the basket itself is
      // untouched and re-chargeable.
      if (itemsMode && cart.length > 0) setAmountDigits("");
      setConnectivityError(
        "No connection — can't reach the network to receive the payment. Check WiFi and try again.",
      );
      return;
    }

    setFinalAmount(amountDecimal);
    setIsGenerating(false);
  };

  // Basket → QR: the cart total becomes the keypad amount (cents) so the
  // whole downstream flow (QR screen, listener reconciliation) is untouched,
  // and the lines are stashed for the itemized receipt.
  const handleChargeCart = () => {
    if (!account || cartCount === 0) return;
    const cents = (cartTotalPlanks / 10n ** BigInt(PUSD_DECIMALS - 2)).toString();
    setAmountDigits(cents);
    setPendingItems(
      cart.map((line) => ({
        name: line.name,
        pricePlanks: line.pricePlanks.toString(),
        quantity: line.quantity,
      })),
    );
    setBasketOpen(false);
    void startPayment(centsToDecimal(cents));
  };

  // Keypad → QR: just amount validation, then straight to the payment screen.
  const handleCharge = () => {
    if (!hasAmount) return;
    void startPayment(enteredAmount);
  };

  const handleReset = () => {
    // If a sale was still in progress (no payment yet), tracking treats
    // this as the merchant abandoning — silent no-op if already completed.
    journeyTracker.abandon("terminal-payment");
    setAmountDigits("");
    setNote("");
    setNoteOpen(false);
    setFinalAmount("");
    setPaymentReceived(null);
    setPartial(null);
    setCoinsShortfall(null);
    setSaleId(null);
    setSvgReceipt(null);
    setShowCancelModal(false);
    setPrintMessage(null);
    setPendingItems([]);
    setCart([]);
    setBasketOpen(false);
    setClearCartConfirm(false);
    setItemSearch("");
    setActiveTab("items");
    clearPendingSale();
    if (searchParams.get("source") === "items") {
      // Sale came from the items menu — return there. `replace` (not `push`)
      // so the back button doesn't bounce into a stale sale screen.
      router.replace("/items");
    } else {
      // Direct checkout: back to a fresh keypad for the next sale.
      setTerminalState("input");
    }
  };

  const handleCancelTransaction = () => {
    setShowCancelModal(false);
    handleReset();
  };

  const handleDownloadReceipt = async () => {
    if (!paymentReceived || !account) return;

    const receiptItems: ReceiptItem[] = pendingItems.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPrice: formatAmountFromPlanck(line.pricePlanks, PUSD_DECIMALS),
    }));

    if (!receivingAddress) return;
    await downloadPdfReceipt({
      amount: formatAmountFromPlanck(paymentReceived.amount, PUSD_DECIMALS),
      asset: getAssetSymbol(),
      merchantAddress: normalizeToAssetHubAddress(receivingAddress),
      customerAddress: paymentReceived.from === "anonymous"
        ? "anonymous"
        : normalizeToAssetHubAddress(paymentReceived.from),
      transactionId: paymentReceived.blockHash,
      blockNumber: paymentReceived.blockNumber,
      blockHash: paymentReceived.blockHash,
      assetId: ASSET_ID_STR,
      saleId: paymentReceived.saleId,
      items: receiptItems.length > 0 ? receiptItems : undefined,
      subtotal: subtotalDecimal,
      tip: tipDecimal,
    });
  };

  const handlePrintReceipt = async () => {
    if (!paymentReceived || !receivingAddress || isPrintingReceipt) return;

    const receiptItems: ReceiptItem[] = pendingItems.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPrice: formatAmountFromPlanck(line.pricePlanks, PUSD_DECIMALS),
    }));

    setIsPrintingReceipt(true);
    setPrintMessage(null);
    try {
      const receiptData = {
        amount: formatAmountFromPlanck(paymentReceived.amount, PUSD_DECIMALS),
        asset: getAssetSymbol(),
        merchant: normalizeToAssetHubAddress(receivingAddress),
        business: businessProfile,
        merchantAddress: normalizeToAssetHubAddress(receivingAddress),
        customerAddress: paymentReceived.from === "anonymous"
          ? "anonymous"
          : normalizeToAssetHubAddress(paymentReceived.from),
        transactionId: paymentReceived.blockHash,
        blockNumber: paymentReceived.blockNumber,
        blockHash: paymentReceived.blockHash,
        assetId: ASSET_ID_STR,
        saleId: paymentReceived.saleId,
        terminalId: terminalId ?? undefined,
        merchantId: adminPayload?.merchantId,
        items: receiptItems.length > 0 ? receiptItems : undefined,
        subtotal: subtotalDecimal,
        tip: tipDecimal,
      };
      await printHostDocument(
        buildCustomerReceiptPrintDocument(receiptData, buildReceiptQrValue(receiptData)),
      );
      setPrintMessage({ tone: "success", text: "Sent to printer." });
    } catch (err) {
      console.error("[Printer] Failed to print receipt:", err);
      setPrintMessage({ tone: "error", text: "Printing failed. Check the printer and try again." });
    } finally {
      setIsPrintingReceipt(false);
    }
  };


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

  // Input State, items mode — the item grid is the entry screen (default
  // tab), the keypad lives one tap away as "Amount" and feeds the basket as
  // Custom Amount lines. Charging hands the basket total to the same QR flow
  // the keypad uses.
  if (terminalState === "input" && itemsMode) {
    const query = itemSearch.trim().toLowerCase();
    const filteredItems = query
      ? checkoutItems.items.filter((i) => i.name.toLowerCase().includes(query))
      : checkoutItems.items;
    const qtyInCart = (id: string) =>
      cart.find((line) => line.id === id)?.quantity ?? 0;

    // Optional receipt note, same inline control as the plain keypad screen;
    // lives in the basket, right above Charge.
    const noteField = (
      <NoteField
        value={note}
        onChange={setNote}
        open={noteOpen}
        onOpenChange={setNoteOpen}
      />
    );

    // Error tint (bg-action-error) + error text: quiet enough to sit under the
    // keypad the whole time the terminal is offline.
    const connectivityWarning = (!connectivity.isOnline || connectivityError) && (
      <div
        data-testid="terminal-connectivity-warning"
        className="rounded-nested bg-action-error px-4 py-3 text-center mt-3"
      >
        <p className="text-label-m text-fg-error">
          {connectivityError ?? "Offline — can't reach the network to settle a sale."}
        </p>
      </div>
    );

    // Bottom dock, shared by both tabs and the basket: basket button with the
    // count badge + the main action. On the Amount tab a typed amount turns
    // the action into "Add to basket"; everywhere else it charges the basket.
    // Charge is the view's one main action, so it takes the pill; "Add" is
    // its alternative in the same slot and keeps the shape at secondary.
    const dock = (
      <div className="flex items-center gap-3 mt-4">
        <button
          data-testid="cart-button"
          onClick={() => cartCount > 0 && setBasketOpen(true)}
          aria-label="Open basket"
          className="relative size-14 shrink-0 rounded-full bg-action-secondary text-fg-primary hover:bg-action-secondary-hover flex items-center justify-center transition-colors"
        >
          <ShoppingCart className="size-6" aria-hidden />
          {cartCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-action-primary text-fg-primary-inverted text-label-s flex items-center justify-center">
              {cartCount}
            </span>
          )}
        </button>
        {!basketOpen && activeTab === "amount" && hasAmount ? (
          <Button
            variant="secondary"
            data-testid="items-add-custom"
            onClick={addCustomAmount}
            className="flex-1 h-auto rounded-full px-6 py-3.5 text-label-l"
          >
            Add {enteredAmount} {symbol}
          </Button>
        ) : (
          <Button
            data-testid="items-charge"
            onClick={handleChargeCart}
            disabled={cartCount === 0}
            className="flex-1 h-auto rounded-full px-6 py-3.5 text-label-l font-semibold disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100"
          >
            Charge {cartTotalDecimal} {symbol}
          </Button>
        )}
      </div>
    );

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
          {basketOpen ? (
            /* ——— Basket ——— */
            <>
              <header className="flex items-center justify-between px-4 py-4 shrink-0">
                <button
                  onClick={() => setBasketOpen(false)}
                  className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
                  aria-label="Close basket"
                >
                  <ChevronDown className="size-6" />
                </button>
                <Button
                  variant="secondary"
                  onClick={() => setClearCartConfirm(true)}
                  className="text-label-m"
                >
                  Clear cart
                </Button>
              </header>

              <main className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 flex flex-col">
                {/* Rows of paired values: one style per row, the value ranked
                    by its mono face and fg step — never by size or weight. */}
                <div className="flex justify-between items-baseline py-3 border-b shrink-0">
                  <span className="text-body-l text-fg-secondary">Total</span>
                  <span className="text-body-l font-mono text-fg-primary">
                    {cartTotalDecimal} {symbol}
                  </span>
                </div>

                {cart.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-start justify-between gap-3 py-4 border-b"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="size-6 rounded-full bg-action-primary text-fg-primary-inverted text-label-s flex items-center justify-center shrink-0 mt-0.5">
                        {line.quantity}
                      </span>
                      <div className="min-w-0">
                        <p className="text-label-l text-fg-primary break-words">{line.name}</p>
                        {line.quantity > 1 && (
                          <p className="text-body-m font-mono text-fg-tertiary mt-0.5">
                            {tilePrice(line.pricePlanks)} {symbol}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <span className="text-label-l font-mono text-fg-primary">
                        {formatAmountFromPlanck(
                          (line.pricePlanks * BigInt(line.quantity)).toString(),
                          PUSD_DECIMALS,
                        )}{" "}
                        {symbol}
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => changeCartQuantity(line.id, 1)}
                          aria-label={`Add one ${line.name}`}
                          className="size-9 rounded-full bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover flex items-center justify-center transition-colors"
                        >
                          <Plus className="size-4" />
                        </button>
                        <button
                          onClick={() => changeCartQuantity(line.id, -1)}
                          aria-label={`Remove one ${line.name}`}
                          className="size-9 rounded-full bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover flex items-center justify-center transition-colors"
                        >
                          <Minus className="size-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex-1" />
                <div className="pt-4">{noteField}</div>
                {dock}
              </main>
            </>
          ) : (
            <>
              {/* Amount | Items tabs — Items is the default. Fixed h-20 so the
                  header matches ScreenHeader's height on the other tabs. */}
              <header className="px-6 h-20 flex items-center gap-4 shrink-0">
                <button
                  onClick={() => setActiveTab("amount")}
                  aria-current={activeTab === "amount" ? "page" : undefined}
                  className={`text-display-l transition-colors ${
                    activeTab === "amount"
                      ? "text-fg-primary"
                      : "text-fg-tertiary hover:text-fg-secondary-hover"
                  }`}
                >
                  Amount
                </button>
                <button
                  onClick={() => setActiveTab("items")}
                  aria-current={activeTab === "items" ? "page" : undefined}
                  className={`text-display-l transition-colors ${
                    activeTab === "items"
                      ? "text-fg-primary"
                      : "text-fg-tertiary hover:text-fg-secondary-hover"
                  }`}
                >
                  Items
                </button>
              </header>

              {activeTab === "items" ? (
                /* ——— Item grid ——— */
                <main className="flex-1 min-h-0 flex flex-col px-6 pb-4">
                  <h2 className="text-heading-l text-fg-primary mb-3 shrink-0">
                    All Items
                  </h2>
                  <div className="relative shrink-0 mb-2">
                    <Search
                      className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-tertiary"
                      aria-hidden
                    />
                    <Input
                      value={itemSearch}
                      onChange={(e) => setItemSearch(e.target.value)}
                      placeholder="Search items"
                      aria-label="Search items"
                      className="h-11 rounded-full pl-10"
                    />
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto pt-3 -mx-1 px-1">
                    {checkoutItems.items.length === 0 ? (
                      <p className="text-body-m text-fg-tertiary text-center py-10">
                        No items yet — add them in{" "}
                        <Link
                          href="/settings/items"
                          className="text-fg-link hover:text-fg-link-hover underline transition-colors"
                        >
                          Settings → Show Items in Checkout
                        </Link>
                        , or use the Amount tab.
                      </p>
                    ) : filteredItems.length === 0 ? (
                      <p className="text-body-m text-fg-tertiary text-center py-10">
                        No items match your search.
                      </p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2.5">
                        {filteredItems.map((item) => {
                          const qty = qtyInCart(item.id);
                          return (
                            /* A tile is a button (tap adds to the basket), so it
                               wears the quiet action surface — no outline. */
                            <button
                              key={item.id}
                              onClick={() => addCatalogItem(item)}
                              className="relative rounded-nested bg-action-tertiary hover:bg-action-tertiary-hover active:bg-action-active p-3 min-h-26 flex flex-col justify-between items-start text-left transition active:scale-95"
                            >
                              {qty > 0 && (
                                <span className="absolute -top-2 -left-2 size-6 rounded-full bg-action-primary text-fg-primary-inverted text-label-s flex items-center justify-center">
                                  {qty}
                                </span>
                              )}
                              <span className="text-label-m text-fg-primary break-words">
                                {item.name}
                              </span>
                              <span className="text-body-s font-mono text-fg-secondary mt-3">
                                {tilePrice(amountToPlanck(item.price, PUSD_DECIMALS))} {symbol}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {connectivityWarning}
                  {dock}
                </main>
              ) : (
                /* ——— Amount tab — same keypad, adds to the basket ——— */
                <main className="flex-1 min-h-0 flex flex-col px-6 pb-4 overflow-y-auto">
                  <div className="mb-6">
                    <AmountHero
                      label="Enter Custom Amount"
                      value={enteredAmount}
                      symbol={symbol}
                      testId="amount-display"
                    />
                  </div>

                  <div className="flex-1 flex flex-col justify-end">
                    <KeypadGrid onDigit={pressDigit} onBackspace={backspaceDigit} />
                    {connectivityWarning}
                    {dock}
                  </div>
                </main>
              )}
            </>
          )}
        </div>

        {/* Clear-cart confirmation sheet. NOTE: the design system bans
            "are you sure?" confirmations in favour of act-then-undo; this one
            is only restyled here and is flagged for that redesign. */}
        {clearCartConfirm && (
          <div
            className="fixed inset-0 z-50 bg-surface-overlay flex items-end justify-center px-3 pb-3"
            onClick={() => setClearCartConfirm(false)}
          >
            <div
              className="w-full max-w-md bg-surface-container rounded-container shadow-3 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-heading-l text-fg-primary text-center mb-6">
                All {cartCount} item{cartCount === 1 ? "" : "s"} will be removed.
                <br />
                This can&apos;t be undone
              </p>
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => setClearCartConfirm(false)}
                  className="flex-1 h-auto py-3.5 text-label-m"
                >
                  Keep cart
                </Button>
                <Button
                  variant="destructive"
                  onClick={clearCart}
                  className="flex-1 h-auto py-3.5 text-label-m text-fg-static-white"
                >
                  Clear all
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Input State — POS keypad (digits fill cents from the right). Header and
  // amount block are the same components Home uses, so switching tabs
  // doesn't move the figure.
  if (terminalState === "input") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          <ScreenHeader title="Amount" testId="terminal-header" />

          {/* Main Content */}
          <main className="flex-1 flex flex-col px-6 pb-4">
            <AmountHero
              label="Enter Payment Amount"
              value={enteredAmount}
              symbol={symbol}
              testId="amount-display"
            />

            {/* Optional receipt note — a quiet "Add note" link until tapped,
                then an inline field. No separate screen for it. */}
            <div className="mt-4">
              <NoteField
                value={note}
                onChange={setNote}
                open={noteOpen}
                onOpenChange={setNoteOpen}
              />
            </div>

            {/* Keypad */}
            <div className="flex-1 flex flex-col justify-end space-y-3 mb-4 mt-6">
              <KeypadGrid onDigit={pressDigit} onBackspace={backspaceDigit} />

              {/* Connectivity warning — periodic offline status or a blocked attempt */}
              {(!connectivity.isOnline || connectivityError) && (
                <div
                  data-testid="terminal-connectivity-warning"
                  className="rounded-nested bg-action-error px-4 py-3 text-center mt-2"
                >
                  <p className="text-label-m text-fg-error">
                    {connectivityError ??
                      "Offline — can't reach the network to settle a sale."}
                  </p>
                </div>
              )}

              {/* Charge — the view's one main action: the primary pill, full
                  width because it is the bottom-anchored commitment of the
                  screen. Disabled state is the surface, not a fade. */}
              <Button
                data-testid="btn-charge"
                onClick={handleCharge}
                disabled={!hasAmount}
                className="w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold mt-4 disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100"
              >
                Charge {enteredAmount} {symbol}
              </Button>
            </div>
          </main>
        </div>
      </div>
    );
  }

  // QR Code State - Waiting for payment
  if (terminalState === "qr") {
    // Coins mode: the first sign a payment is on its way is the cheque landing
    // on our statement-store topic (status flips to "claiming", then "paid"
    // once the host claim goes through). Until then we just show the QR. At
    // that moment we hide the QR and spin, so the merchant sees the payment is
    // arriving. Standard (Voucher) mode keeps its always-on waiting animation.
    const paymentIncoming =
      useCoins &&
      (coinage.status === "claiming" || coinage.status === "paid");
    // The host could not finish claiming the cheque's coins (see
    // lib/payments/coinage/claim.ts). The customer has already paid, so the
    // QR must not come back; the merchant retries the claim or cancels.
    const claimFailed = useCoins && coinage.status === "error";
    const canCancelTransaction = !paymentIncoming && !partial && !paymentReceived;
    // Warning fill while the QR is being armed (connectivity pre-flight or
    // deeplink still computing); the inverted container surface once it's
    // scannable. There is no informational status token — the old brand-blue
    // "waiting" banner is reported as a gap.
    const generating = isGenerating || !displayQrValue;
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
          {/* Status banner — the colored card doubles as the screen header
              and takes the top ~2/5 of the screen, per the design. The host
              already shows a close button; "Cancel Transaction" below covers
              the same intent. Status fills are theme-invariant, so the text on
              the warning fill is static white; the inverted surface takes the
              inverted fg. */}
          <div
            className={`basis-[30%] grow-0 shrink-0 px-6 pb-8 flex flex-col items-center justify-center gap-3 transition-colors ${
              generating || claimFailed
                ? "bg-status-warning text-fg-static-white"
                : "bg-surface-container-inverted text-fg-primary-inverted"
            }`}
          >
            {generating ? (
              <Hourglass className="size-6" aria-hidden />
            ) : claimFailed ? (
              <TriangleAlert className="size-6" aria-hidden />
            ) : (
              <Radio className="size-6" aria-hidden />
            )}
            <h2 data-testid="waiting-text" className="text-display-l text-center">
              {generating
                ? "Generating Payment"
                : claimFailed
                  ? "Claim didn't finish"
                  : paymentIncoming
                  ? "Payment incoming…"
                  : partial
                    ? "Receiving payment…"
                    : FEATURES.nfcTapToPay
                      ? "Scan QR or tap NFC to pay"
                      : "Scan QR to pay"}
            </h2>
          </div>

          {/* Details card — slightly lighter panel whose rounded top overlaps
              the colored banner, per the design's two-tone layout. */}
          <main className="flex-1 min-h-0 overflow-y-auto px-6 flex flex-col bg-surface-container rounded-t-container -mt-6">
            <div className="w-full pt-4 shrink-0">
              <p className="text-body-m text-fg-secondary mb-0.5">Receiving Amount</p>
              <div className="flex items-baseline justify-between gap-4">
                <span
                  data-testid="qr-amount"
                  className="text-display-l font-mono text-fg-primary break-all"
                >
                  {finalAmount || enteredAmount}
                </span>
                <span className="text-label-l text-fg-secondary shrink-0">{symbol}</span>
              </div>
            </div>

            {/* QR sits centered in the remaining space; Cancel is pinned to
                the bottom — matches the design's lower QR placement. */}
            <div className="flex-1 flex flex-col items-center justify-center w-full py-2">
              {/* Multi-group offboard in progress: part of the total has landed,
                  we're still waiting for the remaining recycler groups. A
                  nested-surface chip with warning text and a warning dot —
                  there is no warning tint token (reported as a gap). */}
              {partial && (
                <div
                  data-testid="partial-progress"
                  className="-mt-2 mb-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-nested"
                >
                  <span className="size-2 rounded-full bg-status-warning animate-pulse" />
                  <span className="text-label-m text-fg-warning">
                    Received {formatAmountFromPlanck(partial.received, PUSD_DECIMALS)} of{" "}
                    {formatAmountFromPlanck(partial.requested, PUSD_DECIMALS)} {symbol} — waiting…
                  </span>
                </div>
              )}

              {/* QR Code — a nested-surface placeholder while generating (or
                  once a payment starts arriving). The QR paints its own white
                  quiet zone (marginSize) so it scans on every theme without
                  the card needing a white fill. */}
              <div
                data-testid="qr-code"
                className="rounded-container overflow-hidden bg-surface-nested"
              >
                {paymentIncoming ? (
                  <div className="size-68 flex items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-fg-secondary" />
                  </div>
                ) : claimFailed ? (
                  <div className="size-68 flex items-center justify-center">
                    <TriangleAlert className="size-6 text-fg-warning" aria-hidden />
                  </div>
                ) : displayQrValue ? (
                  <QRCodeSVG value={displayQrValue} size={272} level="H" marginSize={2} />
                ) : (
                  <div className="size-68 flex items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-fg-secondary" />
                  </div>
                )}
              </div>

              {/* Claim progress / failure — plain words; the raw host reason is
                  in the console and telemetry */}
              {useCoins && coinage.status === "claiming" && (
                <p data-testid="coins-claiming" className="text-body-m text-fg-secondary mt-4 text-center max-w-xs">
                  {coinage.claimStage === "detecting"
                    ? "Waiting for the coins to reach the chain"
                    : coinage.claimStage === "claiming"
                      ? "Moving the coins into your balance"
                      : "Handing the payment to the Polkadot app"}
                  {coinage.claimAttempt > 1
                    ? ` · attempt ${coinage.claimAttempt} of ${coinage.claimMaxAttempts}`
                    : ""}
                  . This can take a minute.
                </p>
              )}
              {claimFailed && coinage.error && (
                <p data-testid="coins-claim-error" className="text-body-m text-fg-error mt-4 text-center max-w-xs">
                  {coinage.error}
                </p>
              )}
            </div>

            {/* Cancel pinned to the bottom; error-coloured label while still
                generating. A secondary button — the screen's main action is
                the customer's scan, not this. */}
            {(claimFailed || canCancelTransaction) && (
              <div className="shrink-0 pb-5 flex flex-col gap-2">
                {/* After a failed claim the retry is the screen's main action;
                    Cancel stays beneath it as the quieter alternative. */}
                {claimFailed && (
                  <Button
                    data-testid="btn-retry-claim"
                    onClick={coinage.retryClaim}
                    className="w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold"
                  >
                    Retry claim
                  </Button>
                )}
                {canCancelTransaction && (
                  <Button
                    variant="secondary"
                    onClick={() => setShowCancelModal(true)}
                    className={`w-full h-auto py-3.5 text-label-m ${generating ? "text-fg-error" : ""}`}
                  >
                    Cancel Transaction
                  </Button>
                )}
              </div>
            )}
          </main>
        </div>

        {/* Cancel Modal. NOTE: the design system bans "are you sure?"
            confirmations in favour of act-then-undo; this one is only
            restyled here and is flagged for that redesign. */}
        {showCancelModal && (
          <div className="fixed inset-0 bg-surface-overlay flex items-center justify-center z-50 px-6">
            <div className="bg-surface-container rounded-container shadow-3 w-full max-w-sm p-6">
              <p className="text-heading-l text-fg-primary text-center mb-6">
                Do you want to cancel
                <br />
                this transaction?
              </p>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => setShowCancelModal(false)}
                  className="flex-1 h-auto py-3.5 text-label-m"
                >
                  Close
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleCancelTransaction}
                  className="flex-1 h-auto py-3.5 text-label-m text-fg-static-white"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Payment Completed State
  if (terminalState === "completed") {
    const now = new Date();
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
          {/* Success zone — same top ~2/5 of the screen as the QR banner. A
              success-coloured disc bursts out of the check badge until the
              whole zone is filled (see .success-burst in globals.css);
              overflow-hidden clips the disc to this zone, the details card
              below keeps its container surface. */}
          <div className="relative overflow-hidden basis-[40%] grow-0 shrink-0 flex flex-col">
            <div
              aria-hidden
              className="success-burst absolute left-1/2 top-1/2 size-[1200px] rounded-full bg-status-success pointer-events-none"
            />

            <div className="relative flex-1 flex flex-col">
              {/* Header */}
              <header className="flex items-center px-4 py-4 shrink-0">
                <button
                  onClick={handleReset}
                  className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
                  aria-label="New sale"
                >
                  <ArrowLeft className="size-6" />
                </button>
              </header>

              <div className="flex-1 flex flex-col items-center justify-center pb-8">
                <div className="success-badge size-16 rounded-full bg-status-success text-fg-static-white flex items-center justify-center mb-4">
                  <Check className="size-6" strokeWidth={3} />
                </div>
                <h2 data-testid="payment-completed" className="text-display-l text-fg-primary">
                  Payment received
                </h2>
              </div>
            </div>
          </div>

          {/* Details card — container surface whose rounded top overlaps the
              success zone (page surface, then success fill once the burst
              lands) */}
          <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-6 pb-6 pt-8 bg-surface-container rounded-t-container -mt-6 relative">

            {/* No finality indicator here — best-block is the merchant-side
                terminal state. GRANDPA finalization is stamped on the sale
                record asynchronously by lib/payments/finalization-watcher.ts
                and surfaced as a checkmark in /history. */}

            {/* Amount + order line */}
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <span className="text-display-xl font-mono text-fg-primary break-all">
                {finalAmount}
              </span>
              <span className="text-label-l text-fg-secondary shrink-0">{symbol}</span>
            </div>
            <p className="text-body-m text-fg-secondary mb-6">
              Order <span data-testid="sale-id" className="font-mono">#{saleId?.slice(-4) || "----"}</span>
              {" · "}
              {now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {" · "}
              {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            </p>
            {coinsShortfall && (
              <p data-testid="coins-shortfall" className="text-body-m text-fg-warning -mt-4 mb-6">
                Received {coinsShortfall.credited} of {coinsShortfall.requested} {symbol}. The rest didn&apos;t arrive.
              </p>
            )}

            {/* Receipt note typed on the amount screen */}
            {note.trim() && (
              <div className="flex items-center gap-3 py-3 text-fg-primary">
                <StickyNote className="size-5 text-fg-secondary shrink-0" aria-hidden />
                <span className="text-body-m">{note.trim()}</span>
              </div>
            )}

            <div className="flex-1" />

            {/* Secondary actions — a list of rows on the container surface, so
                the row owns the hover (selection token) and the destructive
                one stays quiet at rest. Receipt tooling and refunds are parked
                behind FEATURES.receipts / FEATURES.refunds for R1. */}
            {(FEATURES.receipts || FEATURES.refunds) && (
            <div className="mb-4 -mx-2">
              {FEATURES.receipts && (
              <button
                onClick={() => setTerminalState("receipt")}
                className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-primary hover:bg-selection-container-hover transition-colors"
              >
                <ReceiptText className="size-5" aria-hidden />
                <span>Review Receipt</span>
              </button>
              )}
              {FEATURES.receipts && printerAvailable && (
                <button
                  onClick={handlePrintReceipt}
                  disabled={isPrintingReceipt}
                  className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-primary hover:bg-selection-container-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  {isPrintingReceipt ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                  ) : (
                    <Printer className="size-5" aria-hidden />
                  )}
                  <span>Print Receipt</span>
                </button>
              )}
              {FEATURES.refunds && (
              <button
                onClick={() =>
                  setPrintMessage({ tone: "error", text: "Refunds aren't available yet." })
                }
                className="w-full flex items-center gap-3 px-2 py-3 rounded-medium text-label-l text-fg-error hover:bg-action-error transition-colors"
              >
                <Undo2 className="size-5" aria-hidden />
                <span>Refund</span>
              </button>
              )}
            </div>
            )}

            {/* Feedback line. Success has no tint token — the nested surface
                carries success-coloured text; error takes the error tint. */}
            {printMessage && (
              <div className={`rounded-nested px-3 py-2 text-body-s mb-4 ${
                printMessage.tone === "success"
                  ? "bg-surface-nested text-fg-success"
                  : "bg-action-error text-fg-error"
              }`}>
                {printMessage.text}
              </div>
            )}

            {/* Done (the view's main action, pill) + share-QR (a circular icon
                button, exempt from the pill count; receipts flag) */}
            <div className="flex gap-3">
              <Button
                data-testid="btn-done"
                onClick={handleReset}
                className="flex-1 h-auto rounded-full px-6 py-3.5 text-label-l font-semibold"
              >
                Done
              </Button>
              {FEATURES.receipts && (
                <Button
                  variant="secondary"
                  onClick={() => setTerminalState("share")}
                  aria-label="Share receipt QR"
                  className="size-14 rounded-full p-0"
                >
                  <QrCode className="size-6" />
                </Button>
              )}
            </div>
          </main>
        </div>
      </div>
    );
  }

  // Share Receipt State
  if (terminalState === "share") {
    // The shared QR carries the exact same self-contained receipt envelope
    // that's printed on the receipt — scanning it rebuilds the full receipt
    // offline (no `/receipt/<id>` round-trip). Built from the same data the
    // listener used to render the receipt, so the two QRs are identical.
    const shareReceiptItems: ReceiptItem[] = pendingItems.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPrice: formatAmountFromPlanck(line.pricePlanks, PUSD_DECIMALS),
    }));
    const shareQrValue = paymentReceived && receivingAddress
      ? buildReceiptQrValue({
          amount: formatAmountFromPlanck(paymentReceived.amount, PUSD_DECIMALS),
          asset: getAssetSymbol(),
          merchantAddress: normalizeToAssetHubAddress(receivingAddress),
          customerAddress: paymentReceived.from === "anonymous"
            ? "anonymous"
            : normalizeToAssetHubAddress(paymentReceived.from),
          transactionId: paymentReceived.blockHash,
          blockNumber: paymentReceived.blockNumber,
          blockHash: paymentReceived.blockHash,
          assetId: ASSET_ID_STR,
          saleId: paymentReceived.saleId,
          items: shareReceiptItems.length > 0 ? shareReceiptItems : undefined,
          subtotal: subtotalDecimal,
          tip: tipDecimal,
        })
      : "";
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-4">
            <button
              onClick={() => setTerminalState("completed")}
              className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
              aria-label="Back to payment"
            >
              <ArrowLeft className="size-6" />
            </button>
            <span className="text-heading-l text-fg-primary">Share Receipt</span>
            <div className="size-10" aria-hidden />
          </header>

          {/* Main Content */}
          <main className="flex-1 flex flex-col items-center px-6 pb-6">
            <div className="size-16 rounded-full bg-illustration-dark text-fg-primary-inverted flex items-center justify-center mt-4 mb-5">
              <ReceiptText className="size-6" aria-hidden />
            </div>
            <h2 className="text-display-l text-fg-primary text-center mb-2">
              Scan QR
              <br />
              to Receive Receipt
            </h2>
            <p className="text-body-l text-fg-secondary mb-8">
              Payment Receipt: Order #{saleId?.slice(-4)}
            </p>

            {/* QR Code — paints its own white quiet zone, so no white card */}
            <div className="rounded-container overflow-hidden mb-8">
              <QRCodeSVG
                value={shareQrValue}
                size={300}
                level="L"
                marginSize={2}
              />
            </div>

            <div className="flex-1" />

            <Button
              variant="secondary"
              onClick={() => setTerminalState("completed")}
              className="w-full h-auto py-3.5 text-label-m"
            >
              Back
            </Button>
          </main>
        </div>
      </div>
    );
  }

  // Receipt Review State
  if (terminalState === "receipt") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-4">
            <button
              onClick={() => setTerminalState("completed")}
              className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
              aria-label="Close receipt"
            >
              <X className="size-6" />
            </button>
            <span className="text-label-l text-fg-primary">Payment Record #{saleId?.slice(-4)}</span>
            <button
              onClick={handleDownloadReceipt}
              className="p-2 rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors"
              aria-label="Download receipt"
            >
              <Download className="size-6" />
            </button>
          </header>

          {/* Receipt Content */}
          <main className="flex-1 flex flex-col px-6 py-4 overflow-auto">
            {svgReceipt ? (
              /* The generated receipt SVG is the printed document: it paints
                 its own paper (a white rect) and ink, so it needs no surface
                 from the theme — only rounded corners to clip to. */
              <div className="rounded-nested overflow-hidden">
                <div dangerouslySetInnerHTML={{ __html: svgReceipt }} />
              </div>
            ) : (
              /* HTML fallback (no SVG yet): a normal themed container. Rows of
                 paired values take one style per row, ranked by fg step/face. */
              <div className="bg-surface-container rounded-nested p-6">
                <div className="border-b pb-4 mb-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-heading-m text-fg-primary">PAYMENT RECEIPT</h3>
                      {paymentReceived?.blockNumber ? (
                        <p className="text-body-s text-fg-secondary">Block: {paymentReceived.blockNumber}</p>
                      ) : null}
                    </div>
                    <span className="text-body-m font-mono text-fg-secondary">#{saleId?.slice(-4)}</span>
                  </div>
                </div>

                <div className="space-y-3 text-body-m">
                  <div className="flex justify-between">
                    <span className="text-fg-secondary">TRANSACTION ID</span>
                    <span className="text-fg-primary font-mono">{saleId?.slice(-4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-secondary">DATE</span>
                    <span className="text-fg-primary">{new Date().toLocaleDateString()}</span>
                  </div>
                  <div>
                    <span className="text-fg-secondary">FROM:</span>
                    <p className="text-fg-primary font-mono text-body-s break-all">{paymentReceived?.from}</p>
                  </div>
                  <div>
                    <span className="text-fg-secondary">TO:</span>
                    <p className="text-fg-primary font-mono text-body-s break-all">{account?.address}</p>
                  </div>
                  <div className="flex justify-between pt-4 border-t">
                    <span className="text-fg-secondary">TOTAL</span>
                    <span className="text-fg-primary font-mono">{finalAmount} {symbol}</span>
                  </div>
                </div>
              </div>
            )}

          </main>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Optional receipt note on the amount screen. Collapsed it's a single quiet
 * "Add note" link so the keypad stays the focus; tapped, it becomes an inline
 * field (auto-focused) with an ✕ that clears and collapses it again. Used by
 * the plain keypad screen and the items-mode basket. The note only appears on
 * the merchant's receipt/sale record — never in the payment QR.
 */
function NoteField({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) {
    // A ghost action: no surface, label style, tertiary hover.
    return (
      <button
        type="button"
        data-testid="btn-add-note"
        onClick={() => onOpenChange(true)}
        className="inline-flex items-center gap-2 rounded-medium px-2 -mx-2 py-1 text-label-m text-fg-secondary hover:bg-action-tertiary-hover hover:text-fg-primary transition-colors"
      >
        <StickyNote className="size-4" aria-hidden />
        Add note
      </button>
    );
  }
  // The field is shadcn's Input (a control draws its own hairline); the icon
  // and the clear button float inside its padding.
  return (
    <div>
      <div className="relative">
        <StickyNote
          className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-fg-tertiary"
          aria-hidden
        />
        <Input
          data-testid="sale-note"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={80}
          placeholder="e.g. Amazon Gift Card"
          aria-label="Receipt note"
          className="h-12 pl-11 pr-11"
        />
        <button
          type="button"
          aria-label="Remove note"
          onClick={() => {
            onChange("");
            onOpenChange(false);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-fg-tertiary hover:bg-action-tertiary-hover hover:text-fg-primary transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
      <p className="text-caption text-fg-tertiary mt-1.5">Only visible on your receipt</p>
    </div>
  );
}

/**
 * One keypad key. Quiet action surface, the display style in Martian Mono so
 * the digits are big and tabular. There is no 24px step in the type scale
 * (the old size): display-l (32/40) is the nearest; reported as a gap.
 */
const KEYPAD_KEY =
  "rounded-medium bg-action-tertiary text-fg-primary text-display-l font-mono font-medium py-4 hover:bg-action-tertiary-hover active:bg-action-active transition-colors";

/** The POS digit pad — shared by the plain keypad screen and the items-mode
    Amount tab so the two never drift apart (testids included). */
function KeypadGrid({
  onDigit,
  onBackspace,
}: {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => (
        <button
          key={key}
          data-testid={`calc-digit-${key}`}
          onClick={() => onDigit(key)}
          className={KEYPAD_KEY}
        >
          {key}
        </button>
      ))}
      <button
        data-testid="calc-digit-00"
        onClick={() => onDigit("00")}
        className={KEYPAD_KEY}
      >
        00
      </button>
      <button
        data-testid="calc-digit-0"
        onClick={() => onDigit("0")}
        className={KEYPAD_KEY}
      >
        0
      </button>
      <button
        data-testid="calc-backspace"
        onClick={onBackspace}
        className={`${KEYPAD_KEY} flex items-center justify-center`}
      >
        <Delete className="size-6" aria-hidden />
      </button>
    </div>
  );
}
