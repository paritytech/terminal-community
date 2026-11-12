"use client";

/**
 * The host's payments surface — balance, the statement store that carries a
 * payer's cheque, the coins claim, and host entropy — for whichever host
 * client this launch is on.
 *
 * Why this exists. Every payments module used to import
 * `@novasamatech/host-api-wrapper` directly. That client speaks codec 1; on the
 * TrUAPI runtime it gets no answers, which on device showed up as "No
 * connection — can't reach the network" before every sale (2026-09-30). So
 * each capability below picks its client once, lazily, and hands back the
 * same shape either way. The hooks keep their synchronous subscription API:
 * `deferredSubscription` returns a handle immediately and wires it up when the
 * client has loaded.
 *
 * On the TrUAPI runtime everything goes through `@parity/product-sdk-host`
 * (`getPaymentManager`, `getStatementStore`, `deriveEntropy`) — the SDK is the
 * product-facing layer over `@parity/truapi`, and on a host that publishes
 * its own client the SDK adopts it, so the wire always matches the host. Core
 * 0.26 (trinity-user-agents #1314, #1337, #1338; nightlies from 2026-10-20)
 * gives `payment.topUp` the codec-1 contract: a 32-byte id, then
 * `subscribeTopUpStatus(id)` with the same five statuses. So the claim, its
 * retry and the background finality watcher run unchanged on both clients.
 *
 * Refusals are mapped onto claim.ts's own `TopUpRefusal`, and subscription
 * interrupts are unwrapped to the host's typed reason, so nothing above this
 * module knows which client answered.
 */

import type { HostPaymentTopUpStatusSubscribeItem, HostSubscription } from "@parity/product-sdk-host";
import { TopUpRefusal, type ClaimHost, type TopUpRefusalKind, type TopUpStatusEvent } from "@/lib/payments/coinage/claim";
import { onTruApi } from "./detect";
import { loadHostSdk } from "./sdk";
import { deferredSubscription, type HostSub } from "./subscription";

/** One page of statements, with payloads as bytes whichever client sent them. */
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

// ── TrUAPI refusals and interrupts ────────────────────────────────────────

/**
 * The host's own answer inside whatever carries it. A subscription the host
 * interrupts arrives as a `SubscriptionError` whose message is only
 * "Subscription interrupted" — the typed reason hangs off `.reason`. A failed
 * SDK call throws an `Error` with the host's payload on `.cause`. Either way
 * the payload is the core's `CallError`, with a domain error inside a version
 * envelope: `{ tag: "Domain", value: { tag: "V1", value: { tag: "AlreadyExists" } } }`.
 */
function hostAnswer(error: unknown): unknown {
  let node = error;
  for (let depth = 0; depth < 8; depth++) {
    if (node instanceof Error) {
      const carried = (node as { reason?: unknown }).reason ?? node.cause;
      if (carried === undefined) return node;
      node = carried;
      continue;
    }
    const tagged = node as { tag?: unknown; value?: unknown } | null | undefined;
    if (tagged && typeof tagged === "object" && (tagged.tag === "Domain" || tagged.tag === "V1")) {
      node = tagged.value;
      continue;
    }
    return node;
  }
  return node;
}

/** The refusal's tag and the host's words, e.g. `{ tag: "TopUpNotFound" }`. */
function describeRefusal(error: unknown): { tag: string; reason: string } {
  const answer = hostAnswer(error) as { tag?: unknown; value?: { reason?: unknown } } | null | undefined;
  const tag = answer && typeof answer === "object" && typeof answer.tag === "string" ? answer.tag : "Unknown";
  const words = answer && typeof answer === "object" ? answer.value?.reason : undefined;
  return { tag, reason: typeof words === "string" ? `${tag}: ${words}` : tag };
}

const REFUSAL_KINDS: ReadonlySet<string> = new Set<TopUpRefusalKind>([
  "AlreadyExists",
  "SourceBusy",
  "InvalidSource",
  "InsufficientFunds",
]);

/**
 * A TrUAPI top-up refusal as claim.ts reads it. `InvalidAmount` has no kind of
 * its own and reads as `Unknown`, with the host's words kept for the log. A
 * `TypeError` means the host's client has no such call — a core from before
 * the payment bridge.
 */
function truApiTopUpRefusal(error: unknown): Error {
  if (error instanceof TypeError) return new PaymentsUnsupportedError();
  const { tag, reason } = describeRefusal(error);
  return REFUSAL_KINDS.has(tag) ? new TopUpRefusal(tag as TopUpRefusalKind) : new TopUpRefusal("Unknown", reason);
}

/**
 * Adapt an SDK subscription to `HostSub`. The SDK keeps a single interrupt
 * callback and reports a clean end as `undefined`; callers here may register
 * several listeners and expect a payload, and they read the host's reason,
 * not the `SubscriptionError` around it. An interrupt that landed inside
 * `subscribe` is replayed by the SDK on registration and reaches listeners
 * that arrive afterwards.
 */
function fromSdkSubscription(
  subscribe: () => HostSubscription,
  describeEnd: (reason: unknown) => unknown = hostAnswer,
): HostSub {
  const listeners: Array<(payload?: unknown) => void> = [];
  let ended: { payload: unknown } | null = null;
  let stopped = false;
  const end = (payload: unknown) => {
    if (stopped || ended) return;
    ended = { payload };
    for (const cb of listeners) cb(payload);
  };

  let sub: HostSubscription;
  try {
    sub = subscribe();
  } catch (error) {
    // A host client without this call (a core from before the payment bridge).
    end(error instanceof TypeError ? new PaymentsUnsupportedError() : error);
    return {
      unsubscribe() {
        stopped = true;
      },
      onInterrupt(callback) {
        if (ended) callback(ended.payload);
        return () => {};
      },
    };
  }
  sub.onInterrupt((reason) => end(reason === undefined ? { tag: "Completed" } : describeEnd(reason)));

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

async function truApiPaymentManager() {
  const manager = await (await loadHostSdk()).getPaymentManager();
  if (!manager) throw new PaymentsUnsupportedError();
  return manager;
}

/**
 * Whether this launch's host can take a coins payment at all. Codec 1 always
 * could; on the TrUAPI runtime it takes a host client. A core from before the
 * payment bridge (pre-0.26) answers its first payment call as unsupported.
 */
export async function hostPaymentsAvailable(): Promise<boolean> {
  if (!(await onTruApi())) return true;
  return (await (await loadHostSdk()).getPaymentManager()) !== null;
}

function toTopUpStatus(status: HostPaymentTopUpStatusSubscribeItem): TopUpStatusEvent | null {
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

// ── codec-1 refusals ──────────────────────────────────────────────────────

/**
 * A codec-1 top-up refusal as claim.ts reads it. The wrapper throws
 * `PaymentTopUpErr::<Variant>` errors with the host's words on
 * `payload.reason`; anything else (a dropped bridge call) passes through.
 */
function codec1TopUpRefusal(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  const match = /^PaymentTopUpErr::(\w+)$/.exec(name);
  if (!match) return error;
  const words = (error as { payload?: { reason?: unknown } }).payload?.reason;
  const kind = REFUSAL_KINDS.has(match[1]) ? (match[1] as TopUpRefusalKind) : "Unknown";
  return new TopUpRefusal(kind, typeof words === "string" ? words : undefined);
}

// ── balance ─────────────────────────────────────────────────────────────

/** Follow the merchant's available coin balance (in planck). */
export function subscribeHostBalance(onAvailable: (planck: bigint) => void): HostSub {
  return deferredSubscription(async () => {
    if (await onTruApi()) {
      const manager = await truApiPaymentManager();
      return fromSdkSubscription(() => manager.subscribeBalance((item) => onAvailable(BigInt(item.available))));
    }
    const { createPaymentManager } = await import("@novasamatech/host-api-wrapper");
    return createPaymentManager().subscribeBalance((balance) => onAvailable(balance.available));
  });
}

// ── statement store (the payer's cheque arrives here) ─────────────────────

/** Follow statements on `topic`. Payloads come back as bytes on both clients. */
export function subscribeHostStatements(
  topic: Uint8Array,
  onPage: (page: HostStatementsPage) => void,
): HostSub {
  return deferredSubscription(async () => {
    if (await onTruApi()) {
      const sdk = await loadHostSdk();
      const store = await sdk.getStatementStore();
      if (!store) throw new Error("statement store unavailable on the TrUAPI runtime");
      // TrUAPI carries topics and payloads as hex strings.
      return fromSdkSubscription(() =>
        store.subscribe({ matchAny: [sdk.toHex(topic)] }, (page) =>
          onPage({
            isComplete: page.isComplete,
            statements: page.statements.map((s) => ({ data: s.data ? sdk.fromHex(s.data) : undefined })),
          }),
        ),
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
    if (await onTruApi()) {
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
 * `PaymentsUnsupportedError` when the TrUAPI runtime has no host client.
 */
export async function createClaimHost(
  trace: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<ClaimHost> {
  if (!(await onTruApi())) {
    const { createPaymentManager } = await import("@novasamatech/host-api-wrapper");
    const manager = createPaymentManager();
    return {
      topUp: (planck, keys, topUpId) =>
        trace(() =>
          manager.topUp(planck, { type: "coins", keys }, topUpId).catch((error: unknown) => {
            throw codec1TopUpRefusal(error);
          }),
        ),
      subscribeTopUpStatus: (topUpId, onStatus) => manager.subscribeTopUpStatus(topUpId, onStatus),
    };
  }

  const sdk = await loadHostSdk();
  const manager = await truApiPaymentManager();

  return {
    topUp: (planck, keys, topUpId) =>
      trace(async () => {
        try {
          await manager.topUp({
            id: sdk.toHex(topUpId),
            amount: planck,
            source: { tag: "Coins", value: { sr25519SecretKeys: keys.map((k) => sdk.toHex(k)) } },
          });
        } catch (error) {
          throw truApiTopUpRefusal(error);
        }
      }),
    subscribeTopUpStatus: (topUpId, onStatus) =>
      fromSdkSubscription(
        () =>
          manager.subscribeTopUpStatus(sdk.toHex(topUpId), (item) => {
            const status = toTopUpStatus(item);
            if (status) onStatus(status);
            else console.warn("[Coinage] unknown top-up status from the host:", item);
          }),
        // Named by its own tag, so `TopUpNotFound` reads as the NotFound the
        // finality watcher stops on.
        describeRefusal,
      ),
  };
}
