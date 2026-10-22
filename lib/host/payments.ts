"use client";

/**
 * The host's payments surface — balance, the statement store that carries a
 * payer's cheque, the coins claim, and host entropy — for whichever wire codec
 * this launch is on.
 *
 * Why this exists. Every payments module used to import
 * `@novasamatech/host-api-wrapper` directly. That client speaks codec 1; on the
 * TrUAPI runtime it is deliberately inert (lib/host/runtime-init.ts withholds
 * the webview mark so it cannot claim the port), which means every call it
 * makes there waits for an answer that never comes. On device that showed up
 * as "No connection — can't reach the network" before every sale: the
 * reachability probe subscribes to the balance, got nothing for six seconds,
 * and gave up (2026-09-30). The same silence would have followed at every
 * later step — entropy for the QR key, the cheque subscription, the claim.
 *
 * So each capability below picks its client once, lazily, and hands back the
 * same shape either way. The hooks keep their synchronous subscription API:
 * `deferredSubscription` returns a handle immediately and wires it up when the
 * client has loaded.
 *
 * Payments on the TrUAPI runtime. Until core 0.26 every TrUAPI payment call
 * fell through to the core's dot.li stub — no payments at all. Core 0.26
 * (trinity-user-agents #1314, with the Android and iOS bridges in #1337 and
 * #1338; nightlies from 2026-10-20 on) hands them to the app's own engines and
 * gives `payment.topUp` the codec-1 contract: a 32-byte id, then
 * `payment.topUpStatusSubscribe(id)` with the same five statuses. So the claim,
 * its retry and the background finality watcher run unchanged on both codecs.
 *
 * Those calls go straight to the TrUAPI client rather than through the SDK's
 * `getPaymentManager()`, which (0.29) registers a top-up by id but has no way
 * to follow its status. On a host that publishes its own client
 * (lib/host/sdk.ts) the client *is* the host's, so the shape always matches
 * the host. A client without `topUpStatusSubscribe` belongs to a core that
 * predates payments, and is reported as unsupported.
 */

import { PaymentTopUpErr } from "@novasamatech/host-api";
import type { ClaimHost, TopUpStatusEvent } from "@/lib/payments/coinage/claim";
import { isTruApiRuntime } from "./detect";
import type { TruApi } from "@parity/product-sdk-host";
import { getTruApiClient, loadHostSdk } from "./sdk";

/** A host subscription, in the shape both clients return. */
export interface HostSub {
  unsubscribe(): void;
  onInterrupt?(callback: (payload?: unknown) => void): unknown;
}

/** One page of statements, with payloads as bytes whichever codec sent them. */
export interface HostStatementsPage {
  statements: Array<{ data?: Uint8Array }>;
  isComplete: boolean;
}

/** The host answered, and it has no payments on this runtime. */
export class PaymentsUnsupportedError extends Error {
  override readonly name = "PaymentsUnsupportedError";
  constructor() {
    super("payments are not supported by this host runtime");
  }
}

function toHex(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A subscription handle that exists before the subscription does. Interrupt
 * listeners registered early are forwarded once the real one is live; an
 * unsubscribe that races ahead of it is honoured the moment it resolves. A
 * start that throws reports through the interrupt listeners, which is what
 * every caller already does with a host that dropped them.
 */
export function deferredSubscription(start: () => Promise<HostSub>): HostSub {
  let real: HostSub | null = null;
  let stopped = false;
  const interruptListeners: Array<(payload?: unknown) => void> = [];

  void start().then(
    (sub) => {
      if (stopped) {
        sub.unsubscribe();
        return;
      }
      real = sub;
      for (const cb of interruptListeners) sub.onInterrupt?.(cb);
    },
    (error) => {
      if (stopped) return;
      for (const cb of interruptListeners) cb(error);
    },
  );

  return {
    unsubscribe() {
      stopped = true;
      real?.unsubscribe();
    },
    onInterrupt(callback) {
      interruptListeners.push(callback);
      if (real) real.onInterrupt?.(callback);
      return () => {};
    },
  };
}

// ── the TrUAPI payment calls ────────────────────────────────────────────

/** The generated client's subscription object (an ES Observable). */
interface TruApiObservable<T> {
  subscribe(observer: {
    next?: (item: T) => void;
    error?: (reason: unknown) => void;
    complete?: () => void;
  }): { unsubscribe(): void };
}

/** The payment calls of the TrUAPI client, typed by `@parity/truapi`. */
type TruApiPayments = TruApi["payment"];
type TruApiTopUpStatus = Parameters<
  NonNullable<Parameters<ReturnType<TruApiPayments["topUpStatusSubscribe"]>["subscribe"]>[0]>["next"] & {}
>[0];

/** The TrUAPI client's payment calls, or `null` when its core has none. */
async function truApiPayments(): Promise<TruApiPayments | null> {
  const payment = (await getTruApiClient())?.payment as Partial<TruApiPayments> | undefined;
  // The client may be the host's own, built from an older core than this SDK:
  // ask what it has rather than trusting the type.
  if (
    typeof payment?.topUp !== "function" ||
    typeof payment.topUpStatusSubscribe !== "function" ||
    typeof payment.balanceSubscribe !== "function"
  ) {
    return null;
  }
  return payment as TruApiPayments;
}

/**
 * Whether this launch's host can take a coins payment at all. Codec 1 always
 * could; on the TrUAPI runtime it takes a core with the payment bridge.
 */
export async function hostPaymentsAvailable(): Promise<boolean> {
  if (!isTruApiRuntime()) return true;
  return (await truApiPayments()) !== null;
}

/**
 * The tag a refusal comes down to. The client reports one as the core's
 * `CallError`, with a domain error inside a version envelope —
 * `{ tag: "Domain", value: { tag: "V1", value: { tag: "AlreadyExists" } } }` —
 * or as a bare `{ tag: "Unsupported" }` and its siblings.
 */
function refusalTag(error: unknown): string | undefined {
  let node = error as { tag?: unknown; value?: unknown } | null | undefined;
  while (node && typeof node === "object" && (node.tag === "Domain" || node.tag === "V1")) {
    node = node.value as typeof node;
  }
  return node && typeof node === "object" && typeof node.tag === "string" ? node.tag : undefined;
}

function refusalReason(error: unknown): string {
  let node = error as { tag?: unknown; value?: unknown } | null | undefined;
  while (node && typeof node === "object" && (node.tag === "Domain" || node.tag === "V1")) {
    node = node.value as typeof node;
  }
  const reason = (node?.value as { reason?: unknown } | undefined)?.reason;
  const tag = refusalTag(error) ?? "Unknown";
  return typeof reason === "string" ? `${tag}: ${reason}` : tag;
}

/**
 * A top-up refusal as the codec-1 error claim.ts already knows how to read:
 * `AlreadyExists` follows the existing registration, `SourceBusy` the previous
 * one, and `InvalidSource` is final. `InvalidAmount` has no codec-1 twin and
 * reads as `Unknown`, with the host's words kept for the log.
 */
function toTopUpError(error: unknown): Error {
  switch (refusalTag(error)) {
    case "AlreadyExists":
      return new PaymentTopUpErr.AlreadyExists();
    case "SourceBusy":
      return new PaymentTopUpErr.SourceBusy();
    case "InvalidSource":
      return new PaymentTopUpErr.InvalidSource();
    default:
      return new PaymentTopUpErr.Unknown({ reason: refusalReason(error) });
  }
}

function toTopUpStatus(status: TruApiTopUpStatus): TopUpStatusEvent | null {
  switch (status.tag) {
    case "Detecting":
      return { type: "detecting" };
    case "Claiming":
      return { type: "claiming" };
    case "Claimed":
      return { type: "claimed", finalized: status.value.finalized };
    case "ClaimedPartially":
      return { type: "claimedPartially", actualClaimed: status.value.actualClaimed };
    case "NotClaimed":
      return { type: "notClaimed" };
    default:
      // A status this build does not know yet — a newer core's addition.
      return null;
  }
}

/**
 * Adapt a client observable to `HostSub`. The stream's error, or its end
 * before the caller let go, reaches the interrupt listeners — including ones
 * registered after the fact, since a host can refuse inside `subscribe`.
 */
function fromObservable<T>(
  observable: TruApiObservable<T>,
  onItem: (item: T) => void,
  describeEnd: (reason: unknown) => unknown = (reason) => reason,
): HostSub {
  const listeners: Array<(payload?: unknown) => void> = [];
  let stopped = false;
  let ended: { payload: unknown } | null = null;
  const end = (payload: unknown) => {
    if (stopped || ended) return;
    ended = { payload };
    for (const cb of listeners) cb(payload);
  };

  const sub = observable.subscribe({
    next: (item) => {
      if (!stopped && !ended) onItem(item);
    },
    error: (reason) => end(describeEnd(reason)),
    complete: () => end({ tag: "Completed" }),
  });

  return {
    unsubscribe() {
      stopped = true;
      sub.unsubscribe();
    },
    onInterrupt(callback) {
      if (ended) callback(ended.payload);
      else listeners.push(callback);
      return () => {};
    },
  };
}

// ── balance ─────────────────────────────────────────────────────────────

/** Follow the merchant's available coin balance (in planck). */
export function subscribeHostBalance(onAvailable: (planck: bigint) => void): HostSub {
  return deferredSubscription(async () => {
    if (isTruApiRuntime()) {
      const payment = await truApiPayments();
      if (!payment) throw new PaymentsUnsupportedError();
      return fromObservable(payment.balanceSubscribe({ request: {} }), (item) =>
        onAvailable(BigInt(item.available)),
      );
    }
    const { createPaymentManager } = await import("@novasamatech/host-api-wrapper");
    return createPaymentManager().subscribeBalance((balance) => onAvailable(balance.available));
  });
}

// ── statement store (the payer's cheque arrives here) ─────────────────────

/** Follow statements on `topic`. Payloads come back as bytes on both codecs. */
export function subscribeHostStatements(
  topic: Uint8Array,
  onPage: (page: HostStatementsPage) => void,
): HostSub {
  return deferredSubscription(async () => {
    if (isTruApiRuntime()) {
      const store = await (await loadHostSdk()).getStatementStore();
      if (!store) throw new Error("statement store unavailable on the TrUAPI runtime");
      // Codec 2 carries topics and payloads as hex strings.
      return store.subscribe({ matchAny: [toHex(topic)] }, (page) =>
        onPage({
          isComplete: page.isComplete,
          statements: page.statements.map((s) => ({ data: s.data ? fromHex(s.data) : undefined })),
        }),
      );
    }
    const { createStatementStore } = await import("@novasamatech/host-api-wrapper");
    return createStatementStore().subscribe({ matchAny: [topic] }, (page) =>
      onPage({
        isComplete: page.isComplete,
        statements: page.statements.map((s) => ({ data: s.data })),
      }),
    );
  });
}

// ── entropy (the QR's ephemeral key) ────────────────────────────────────

/**
 * Host entropy for `label`, or `null` when the host cannot provide it — the
 * caller then keeps its own CSPRNG bytes. Never waits on a client that cannot
 * answer, which on the TrUAPI runtime would have held every QR for the
 * codec-1 handshake timeout.
 */
export async function deriveHostEntropy(label: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (isTruApiRuntime()) {
      const result = await (await loadHostSdk()).deriveEntropy(label);
      return result.ok ? result.value : null;
    }
    const { deriveEntropy } = await import("@novasamatech/host-api-wrapper");
    const result = await deriveEntropy(label);
    return result.isOk() ? result.value : null;
  } catch {
    return null;
  }
}

// ── the coins claim ─────────────────────────────────────────────────────

/**
 * The claim host for this launch. `trace` wraps the registration call so a
 * claim correlates across payer and terminal in one trace. Rejects with
 * `PaymentsUnsupportedError` on a TrUAPI core without payments.
 */
export async function createClaimHost(
  trace: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<ClaimHost> {
  if (!isTruApiRuntime()) {
    const { createPaymentManager } = await import("@novasamatech/host-api-wrapper");
    const manager = createPaymentManager();
    return {
      topUp: (planck, keys, topUpId) =>
        trace(() => manager.topUp(planck, { type: "coins", keys }, topUpId)),
      subscribeTopUpStatus: (topUpId, onStatus) => manager.subscribeTopUpStatus(topUpId, onStatus),
    };
  }

  const payment = await truApiPayments();
  if (!payment) throw new PaymentsUnsupportedError();

  return {
    topUp: (planck, keys, topUpId) =>
      trace(async () => {
        const result = await payment.topUp({
          amount: planck,
          source: { tag: "Coins", value: { sr25519SecretKeys: keys.map((k) => toHex(k)) } },
          id: toHex(topUpId),
        });
        if (result.isErr()) throw toTopUpError(result.error);
      }),
    subscribeTopUpStatus: (topUpId, onStatus) =>
      fromObservable(
        payment.topUpStatusSubscribe({ request: { id: toHex(topUpId) } }),
        (item) => {
          const status = toTopUpStatus(item);
          if (status) onStatus(status);
          else console.warn("[Coinage] unknown top-up status from the host:", item);
        },
        // Named by its own tag, so `TopUpNotFound` reads as the NotFound the
        // finality watcher stops on.
        (reason) => ({ tag: refusalTag(reason) ?? "Unknown", reason: refusalReason(reason) }),
      ),
  };
}
