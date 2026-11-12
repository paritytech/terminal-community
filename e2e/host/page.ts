// Browser entry of the Terminal's own test host.
// Bundled by esbuild (iife) and inlined into the host HTML. Runs in the
// TOP-level page; only the product <iframe> ever reloads, so every Map below
// survives product reloads by construction (like a real host surviving an
// app restart).
import {
  createContainer,
  createIframeProvider,
  deriveProductEntropy,
  derivationIndexBytes,
  type Container,
} from "@novasamatech/host-container";
import {
  DeriveEntropyErr,
  GenericError,
  PaymentBalanceErr,
  PaymentTopUpErr,
  PaymentTopUpStatusErr,
  PreimageSubmitErr,
  RequestCredentialsErr,
  SigningErr,
  StorageErr,
  toHex,
  type CodecType,
  type PaymentTopUpStatus,
  type SignedStatement,
  type Theme,
} from "@novasamatech/host-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { devRoot, getPublicKey, productSecret, sign } from "./keys";
import type {
  AccountGetMode,
  BalanceMode,
  HostConfig,
  HostEvent,
  Hex,
  StorageMode,
  TopUpAnswer,
  TopUpRecord,
  TopUpScript,
  TopUpStatusWire,
} from "./protocol";

declare global {
  interface Window {
    __T3_HOST_CONFIG__?: HostConfig;
    __t3HostEmit?: (event: HostEvent) => void; // page.exposeBinding
    __T3_HOST__?: ReturnType<typeof createControl>;
  }
}

type Status = CodecType<typeof PaymentTopUpStatus>;
type Stmt = CodecType<typeof SignedStatement>;

const hex = (b: Uint8Array) => toHex(b) as Hex;
const unhex = (h: string) => Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/../g) ?? [], (x) => parseInt(x, 16));
const emit = (e: HostEvent) => {
  try { window.__t3HostEmit?.(e); } catch { /* fixture gone */ }
};

// ── state that outlives product reloads ─────────────────────────────────
const cfg = window.__T3_HOST_CONFIG__!;
const root = devRoot(cfg.root);
const storage = new Map<string, Uint8Array>();
const preimages = new Map<Hex, Uint8Array>();
const statements: Stmt[] = [];
const topUps = new Map<Hex, TopUpRecord>();
const permissionAnswers = new Map<string, boolean>(); // default: grant
const devicePermissionAnswers = new Map<string, boolean>();
let balance = BigInt(cfg.balance);
let balanceMode: BalanceMode = cfg.balanceMode ?? "send";
let theme: CodecType<typeof Theme> = toTheme(cfg.theme);
let accountConnected = true;
let accountGetMode: AccountGetMode = cfg.accountGetMode ?? "ok";
let storageMode: StorageMode = cfg.storageMode ?? "ok";
let entropyMode: "derive" | "error" = cfg.entropyMode ?? "derive";
const topUpAnswers: Array<{ answer: TopUpAnswer; times: number }> = [];
let topUpScript: TopUpScript = cfg.topUpScript ?? [
  { status: { tag: "Detecting" }, afterMs: 50 },
  { status: { tag: "Claiming" }, afterMs: 150 },
  { status: { tag: "Claimed", finalized: false }, afterMs: 150 },
  // finality is left to the spec: host.emitTopUpStatus(id, { tag: "Claimed", finalized: true })
];
for (const [key, json] of Object.entries(cfg.storage ?? {})) {
  storage.set(key, new TextEncoder().encode(JSON.stringify(json)));
}

// Live subscribers, tagged with the product document generation that opened
// them. A product document that goes away never sends `stop` for its
// subscriptions; restartProduct() bumps the generation and drops the old
// ones. (The handshake cannot mark the boundary: the product posts its first
// subscribe before its handshake request.) Reloads the product does on its
// own leave stale subscribers behind; sending to them is harmless.
let generation = 0;
type Sub<T> = { gen: number; send: (v: T) => void; interrupt?: () => void };
const themeSubs = new Set<Sub<CodecType<typeof Theme>>>();
const balanceSubs = new Set<Sub<{ available: bigint }>>();
const accountSubs = new Set<Sub<"connected" | "disconnected">>();
const statementSubs = new Set<Sub<Stmt> & { matches: (s: Stmt) => boolean; topics: Hex[] }>();
const topUpSubs = new Map<Hex, Set<Sub<Status> & { interruptWith: (e: unknown) => void }>>();
const preimageSubs = new Map<Hex, Set<Sub<Uint8Array | null>>>();
const storageSubs = new Map<string, Set<Sub<{ value: Uint8Array | undefined }>>>();

function track<T>(set: Set<T>, sub: T): () => void {
  set.add(sub);
  return () => void set.delete(sub);
}

function toTheme(t: "light" | "dark"): CodecType<typeof Theme> {
  return { name: { tag: "Default", value: undefined }, variant: t === "dark" ? "Dark" : "Light" };
}

function toStatus(w: TopUpStatusWire): Status {
  switch (w.tag) {
    case "Detecting": return { tag: "Detecting", value: undefined };
    case "Claiming": return { tag: "Claiming", value: undefined };
    case "Claimed": return { tag: "Claimed", value: { finalized: w.finalized } };
    case "ClaimedPartially": return { tag: "ClaimedPartially", value: { actualClaimed: BigInt(w.actualClaimed) } };
    case "NotClaimed": return { tag: "NotClaimed", value: undefined };
  }
}
const isTerminal = (w: TopUpStatusWire) =>
  (w.tag === "Claimed" && w.finalized) || w.tag === "ClaimedPartially" || w.tag === "NotClaimed";

function productKey(productId: string, index: Parameters<typeof derivationIndexBytes>[0]) {
  return productSecret(root, productId, derivationIndexBytes(index));
}

// ── wiring ──────────────────────────────────────────────────────────────
function wire(container: Container, productId: string): void {
  container.subscribeProductConnectionStatus((status) => emit({ type: "connection", status }));

  // No chain is served: the coins flow never reads one, and the app opens no
  // connection of its own, so the run is hermetic.
  container.handleFeatureSupported((_feature, { ok }) => ok(false));

  // accounts
  container.handleAccountConnectionStatusSubscribe((_, send) => {
    send(accountConnected ? "connected" : "disconnected");
    return track(accountSubs, { gen: generation, send });
  });
  container.handleAccountGet(([dotnsId, index], { ok, err }) => {
    emit({ type: "accountGet", productId: dotnsId, index: JSON.stringify(index) });
    if (accountGetMode === "hang") return new Promise<never>(() => {});
    if (!accountConnected || accountGetMode === "NotConnected") return err(new RequestCredentialsErr.NotConnected());
    if (accountGetMode === "Rejected") return err(new RequestCredentialsErr.Rejected());
    return ok({ publicKey: getPublicKey(productKey(dotnsId, index)) });
  });
  container.handleGetLegacyAccounts((_, { ok }) =>
    ok(cfg.legacyAccounts ? [{ publicKey: getPublicKey(root), name: cfg.root }] : []),
  );
  container.handleSignRaw(({ account: [dotnsId, index], payload }, { ok, err }) => {
    if (!accountConnected) return err(new SigningErr.Rejected());
    const bytes = payload.tag === "Bytes" ? payload.value : new TextEncoder().encode(payload.value);
    return ok({ signature: hex(sign(productKey(dotnsId, index), bytes)), signedTransaction: undefined });
  });

  // theme / storage
  container.handleThemeSubscribe((_, send) => {
    send(theme);
    return track(themeSubs, { gen: generation, send });
  });
  container.handleLocalStorageRead((key, { ok, err }) =>
    storageMode === "Unknown" ? err(new StorageErr.Unknown({ reason: "test: bridge unhealthy" })) : ok(storage.get(key)),
  );
  container.handleLocalStorageWrite(([key, value], { ok, err }) => {
    if (storageMode !== "ok") emit({ type: "storageWriteRejected", key, mode: storageMode });
    if (storageMode === "Full") return err(new StorageErr.Full());
    if (storageMode === "Unknown") return err(new StorageErr.Unknown({ reason: "test: bridge unhealthy" }));
    storage.set(key, value);
    emit({ type: "storageWrite", key });
    storageSubs.get(key)?.forEach((s) => s.send({ value }));
    return ok(undefined);
  });
  container.handleLocalStorageClear((key, { ok }) => {
    storage.delete(key);
    storageSubs.get(key)?.forEach((s) => s.send({ value: undefined }));
    return ok(undefined);
  });
  container.handleLocalStorageSubscribe(({ key }, send) => {
    send({ value: storage.get(key) });
    const set = storageSubs.get(key) ?? new Set();
    storageSubs.set(key, set);
    return track(set, { gen: generation, send });
  });

  // entropy (RFC-0007, deterministic per productId+key — the QR's X25519 key)
  container.handleDeriveEntropy((key, { ok, err }) => {
    emit({ type: "entropy", keyHex: hex(key) });
    if (entropyMode === "error") return err(new DeriveEntropyErr.Unknown({ reason: "test: no entropy" }));
    return ok(deriveProductEntropy(root.slice(0, 32), productId, key));
  });

  // permissions — StatementSubmit/PreimageSubmit are gated by the container
  // through this handler before the submit handler runs.
  container.handlePermission((perm, { ok }) => {
    const granted = permissionAnswers.get(perm.tag) ?? true;
    emit({ type: "permission", tag: perm.tag, granted });
    return ok(granted);
  });
  container.handleDevicePermission((request, { ok }) => {
    const granted = devicePermissionAnswers.get(request) ?? true;
    emit({ type: "devicePermission", request, granted });
    return ok(granted);
  });
  container.handleRequestResourceAllocation((resources, { ok }) => {
    emit({ type: "resourceAllocation", resources: resources.map((r) => r.tag) });
    return ok(resources.map(() => ({ tag: "Allocated" as const, value: undefined })));
  });
  container.handleNavigateTo((url, { ok }) => {
    emit({ type: "navigate", url });
    return ok(undefined);
  });

  // statement store — the payer's cheque arrives here
  container.handleStatementStoreSubscribe((filter, send) => {
    const want = filter.value.map(hex);
    emit({ type: "statementSubscribe", filter: filter.tag, topics: want });
    const matches = (s: Stmt) => {
      if (want.length === 0) return true;
      const have = s.topics.map(hex);
      return filter.tag === "MatchAll" ? want.every((t) => have.includes(t)) : want.some((t) => have.includes(t));
    };
    // replay what the store already holds — a cheque injected before the
    // terminal subscribed must still be seen (real store semantics)
    send({ statements: statements.filter(matches), isComplete: true });
    const off = track(statementSubs, {
      gen: generation,
      matches,
      topics: want,
      send: (s) => send({ statements: [s], isComplete: true }),
    });
    return () => {
      off();
      emit({ type: "statementUnsubscribe", topics: want });
    };
  });
  container.handleStatementStoreSubmit((statement, { ok }) => {
    statements.push(statement);
    emit({ type: "statementSubmit", topics: statement.topics.map(hex) });
    statementSubs.forEach((s) => s.matches(statement) && s.send(statement));
    return ok(undefined);
  });

  // preimages (Bulletin through the host)
  container.handlePreimageSubmit((value, { ok, err }) => {
    if (permissionAnswers.get("PreimageSubmit") === false) return err(new PreimageSubmitErr.Unknown({ reason: "denied" }));
    const key = hex(blake2b256(value));
    preimages.set(key, value);
    emit({ type: "preimageSubmit", key });
    preimageSubs.get(key)?.forEach((s) => s.send(value));
    return ok(key);
  });
  container.handlePreimageLookupSubscribe((key, send) => {
    const k = key.toLowerCase() as Hex;
    emit({ type: "preimageLookup", key: k, found: preimages.has(k) });
    send(preimages.get(k) ?? null);
    const set = preimageSubs.get(k) ?? new Set();
    preimageSubs.set(k, set);
    return track(set, { gen: generation, send });
  });

  // payments — balance
  container.handlePaymentBalanceSubscribe((_, send, interrupt) => {
    emit({ type: "balanceSubscribe" });
    if (balanceMode === "PermissionDenied") { interrupt(new PaymentBalanceErr.PermissionDenied()); return () => {}; }
    if (balanceMode === "Unsupported") { interrupt(new PaymentBalanceErr.Unknown({ reason: "Unsupported" })); return () => {}; }
    // What host-container answers when the host registers no balance handler.
    if (balanceMode === "NotImplemented") { interrupt(new PaymentBalanceErr.Unknown({ reason: "Not implemented" })); return () => {}; }
    if (balanceMode === "send") send({ available: balance });
    return track(balanceSubs, { gen: generation, send });
  });

  // payments — top up (registration only; the outcome goes over status subscribe)
  container.handlePaymentTopUp(({ into, amount, source, id }, { ok, err }) => {
    const idHex = hex(id);
    const record: TopUpRecord = {
      idHex,
      amount: amount.toString(),
      into: into ?? null,
      source:
        source.tag === "Coins" ? { tag: "Coins", keys: source.value.map(hex) }
        : source.tag === "PrivateKey" ? { tag: "PrivateKey", key: hex(source.value) }
        : { tag: "ProductAccount", index: source.value },
      answer: "accept",
      statuses: [],
      terminal: false,
      at: Date.now(),
    };
    const forced = topUpAnswers[0];
    if (forced && --forced.times <= 0) topUpAnswers.shift();
    const answer: TopUpAnswer = forced?.answer ?? "accept";

    // real semantics first, then the forced answer
    const busy = record.source.tag === "Coins" && [...topUps.values()].some(
      (t) => !t.terminal && t.source.tag === "Coins" && t.source.keys.some((k) => (record.source as { keys: Hex[] }).keys.includes(k)),
    );
    const result =
      answer === "hang" ? "hang"
      : topUps.has(idHex) || answer === "AlreadyExists" ? "AlreadyExists"
      : busy || answer === "SourceBusy" ? "SourceBusy"
      : answer === "InvalidSource" ? "InvalidSource"
      : typeof answer === "object" ? "Unknown"
      : "accept";
    record.answer = result;
    emit({ type: "topUp", record });
    // A forced AlreadyExists means "the host already has this registration":
    // keep it, so the product's follow-up status subscribe finds it.
    if (result === "AlreadyExists" && !topUps.has(idHex)) {
      topUps.set(idHex, { ...record, answer: "accept" });
      runScript(idHex);
    }
    switch (result) {
      case "hang": return new Promise<never>(() => {});
      case "AlreadyExists": return err(new PaymentTopUpErr.AlreadyExists());
      case "SourceBusy": return err(new PaymentTopUpErr.SourceBusy());
      case "InvalidSource": return err(new PaymentTopUpErr.InvalidSource());
      case "Unknown": return err(new PaymentTopUpErr.Unknown({ reason: (answer as { Unknown: string }).Unknown }));
    }
    topUps.set(idHex, record);
    runScript(idHex);
    return ok(undefined);
  });

  container.handlePaymentTopUpStatusSubscribe((id, send, interrupt) => {
    const idHex = hex(id);
    const record = topUps.get(idHex);
    emit({ type: "topUpStatusSubscribe", idHex, known: !!record });
    if (!record) {
      interrupt(new PaymentTopUpStatusErr.NotFound());
      return () => {};
    }
    // "keep that status readable indefinitely": a late subscriber gets the latest status
    const last = record.statuses.at(-1);
    if (last) send(toStatus(last));
    if (record.terminal) return () => {};
    const set = topUpSubs.get(idHex) ?? new Set();
    topUpSubs.set(idHex, set);
    const off = track(set, { gen: generation, send, interruptWith: interrupt as (e: unknown) => void });
    return () => {
      off();
      emit({ type: "topUpStatusUnsubscribe", idHex });
    };
  });
}

function runScript(idHex: Hex): void {
  if (topUpScript === "manual") return;
  let delay = 0;
  for (const step of topUpScript) {
    delay += step.afterMs;
    setTimeout(() => emitTopUpStatus(idHex, step.status), delay);
  }
}

function emitTopUpStatus(idHex: Hex, status: TopUpStatusWire): void {
  const record = topUps.get(idHex);
  if (!record || record.terminal) return; // host sends nothing after terminal
  record.statuses.push(status);
  record.terminal = isTerminal(status);
  if (status.tag === "Claimed" && !status.finalized) {
    balance += BigInt(record.amount);
    balanceSubs.forEach((s) => s.send({ available: balance }));
  }
  topUpSubs.get(idHex)?.forEach((s) => s.send(toStatus(status)));
  if (record.terminal) topUpSubs.delete(idHex);
}

// ── control surface (page.evaluate targets) ──────────────────────────────
function createControl(iframe: HTMLIFrameElement) {
  return {
    setTheme(t: "light" | "dark") { theme = toTheme(t); themeSubs.forEach((s) => s.send(theme)); },
    setAccountConnected(c: boolean) {
      accountConnected = c;
      accountSubs.forEach((s) => s.send(c ? "connected" : "disconnected"));
    },
    setAccountGetMode(m: AccountGetMode) { accountGetMode = m; },
    getProductAccount(productId: string, index = 0): Hex {
      return hex(getPublicKey(productKey(productId, { tag: "Index", value: index })));
    },
    // storage (JSON as the app's host-storage writes it)
    getStorage(key: string): unknown {
      const v = storage.get(key);
      return v && v.length ? JSON.parse(new TextDecoder().decode(v)) : undefined;
    },
    seedStorage(key: string, json: unknown) { storage.set(key, new TextEncoder().encode(JSON.stringify(json))); },
    clearStorage() { storage.clear(); },
    storageKeys(): string[] { return [...storage.keys()]; },
    setStorageMode(m: StorageMode) { storageMode = m; },
    setEntropyMode(m: typeof entropyMode) { entropyMode = m; },
    // statements
    injectStatement(topicsHex: Hex[], dataHex: Hex, signerHex?: Hex, signatureHex?: Hex) {
      const s: Stmt = {
        proof: { tag: "Sr25519", value: { signer: unhex(signerHex ?? "0x" + "00".repeat(32)), signature: unhex(signatureHex ?? "0x" + "00".repeat(64)) } },
        decryptionKey: undefined, expiry: undefined, channel: undefined,
        topics: topicsHex.map(unhex), data: unhex(dataHex),
      };
      statements.push(s);
      statementSubs.forEach((sub) => sub.matches(s) && sub.send(s));
    },
    clearStatements() { statements.length = 0; },
    // balance
    setBalance(planck: string) { balance = BigInt(planck); balanceSubs.forEach((s) => s.send({ available: balance })); },
    setBalanceMode(m: BalanceMode) { balanceMode = m; },
    // top ups
    queueTopUpAnswer(answer: TopUpAnswer, times = 1) { topUpAnswers.push({ answer, times }); },
    setTopUpScript(script: TopUpScript) { topUpScript = script; },
    emitTopUpStatus,
    interruptTopUpStatus(idHex: Hex, reason: "NotFound" | { Unknown: string }) {
      const err = reason === "NotFound" ? new PaymentTopUpStatusErr.NotFound() : new PaymentTopUpStatusErr.Unknown({ reason: reason.Unknown });
      const subs = topUpSubs.get(idHex);
      topUpSubs.delete(idHex);
      subs?.forEach((s) => s.interruptWith(err));
    },
    forgetTopUp(idHex: Hex) { topUps.delete(idHex); },
    getTopUps(): TopUpRecord[] { return [...topUps.values()]; },
    topUpSubscriberCount(idHex: Hex): number { return topUpSubs.get(idHex)?.size ?? 0; },
    statementSubscriberCount(topicHex: Hex): number {
      return [...statementSubs].filter((s) => s.topics.includes(topicHex)).length;
    },
    // permissions, preimages
    setPermission(tag: string, granted: boolean) { permissionAnswers.set(tag, granted); },
    setDevicePermission(request: string, granted: boolean) { devicePermissionAnswers.set(request, granted); },
    getPreimages(): Array<{ key: Hex; size: number }> { return [...preimages].map(([key, v]) => ({ key, size: v.length })); },
    getPreimage(key: Hex): Hex | null { const v = preimages.get(key.toLowerCase() as Hex); return v ? hex(v) : null; },
    seedPreimage(valueHex: Hex): Hex { const v = unhex(valueHex); const k = hex(blake2b256(v)); preimages.set(k, v); return k; },
    // product lifecycle — host state survives, like a real app restart
    restartProduct(path?: string) {
      // Everything the old document subscribed to goes with it.
      generation++;
      const prune = <T extends { gen: number }>(set: Set<T>) => set.forEach((s) => s.gen < generation && set.delete(s));
      [themeSubs, balanceSubs, accountSubs, statementSubs].forEach((s) => prune(s as Set<{ gen: number }>));
      topUpSubs.forEach((s) => prune(s));
      preimageSubs.forEach((s) => prune(s));
      storageSubs.forEach((s) => prune(s));
      iframe.src = new URL(path ?? new URL(iframe.src).pathname, cfg.productUrl).href;
    },
  };
}

// ── boot ────────────────────────────────────────────────────────────────
function boot(): void {
  const iframe = document.getElementById("product-frame") as HTMLIFrameElement;
  const url = new URL(cfg.initialPath, cfg.productUrl).href;
  // createIframeProvider assigns iframe.src itself — assign it NOWHERE else,
  // or the product loads twice (test-sdk 0.11 does exactly that).
  const provider = createIframeProvider({ iframe, url });
  const productId = new URL(cfg.productUrl).host; // what the app reads from location.host
  const container = createContainer(provider, { productId });
  wire(container, productId);

  // Every product document handshakes; tell the specs a document loaded.
  let loads = 0;
  container.onDebugMessage(({ direction, payload }) => {
    if (direction !== "incoming" || payload.tag !== "host_handshake_request") return;
    emit({ type: "productLoad", generation: ++loads });
  });

  window.__T3_HOST__ = createControl(iframe);
}

boot();
