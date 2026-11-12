// e2e/host/protocol.ts — the wire between the Node fixture and the host page.
// Everything crossing page.evaluate / exposeBinding is JSON: bytes as 0x-hex,
// u128 as decimal strings.

export type Hex = `0x${string}`;

export interface HostConfig {
  productUrl: string; // "http://localhost:5199"
  initialPath: string; // "/"
  /** Dev root that the product subtree hangs off. */
  root: "Alice" | "Bob" | "Charlie" | "Dave" | "Eve" | "Ferdie";
  theme: "light" | "dark";
  balance: string; // planck
  legacyAccounts: boolean;
}

export type TopUpStatusWire =
  | { tag: "Detecting" }
  | { tag: "Claiming" }
  | { tag: "Claimed"; finalized: boolean }
  | { tag: "ClaimedPartially"; actualClaimed: string }
  | { tag: "NotClaimed" };

/** What the next host_payment_top_up answers. `times` defaults to 1; `accept` is the default after. */
export type TopUpAnswer =
  | "accept"
  | "AlreadyExists"
  | "SourceBusy"
  | "InvalidSource"
  | { Unknown: string }
  | "hang"; // never answer (bridge dropped)

/** Status script run after an accepted registration. `manual` = only the spec emits. */
export type TopUpScript = "manual" | Array<{ status: TopUpStatusWire; afterMs: number }>;

export interface TopUpRecord {
  idHex: Hex;
  amount: string;
  into: number | null;
  source: { tag: "Coins"; keys: Hex[] } | { tag: "PrivateKey"; key: Hex } | { tag: "ProductAccount"; index: unknown };
  answer: string; // what the host answered
  statuses: TopUpStatusWire[]; // emitted so far
  terminal: boolean;
  at: number;
}

export type HostEvent =
  | { type: "connection"; status: string }
  | { type: "accountGet"; productId: string; index: string; publicKey?: Hex }
  | { type: "storageWrite"; key: string }
  | { type: "statementSubscribe"; filter: "MatchAll" | "MatchAny"; topics: Hex[] }
  | { type: "statementSubmit"; topics: Hex[] }
  | { type: "balanceSubscribe" }
  | { type: "topUp"; record: TopUpRecord }
  | { type: "topUpStatusSubscribe"; idHex: Hex; known: boolean }
  | { type: "topUpStatusUnsubscribe"; idHex: Hex }
  | { type: "entropy"; keyHex: Hex }
  | { type: "permission"; tag: string; granted: boolean }
  | { type: "devicePermission"; request: string; granted: boolean }
  | { type: "navigate"; url: string }
  | { type: "preimageSubmit"; key: Hex }
  | { type: "productLoad"; generation: number };
