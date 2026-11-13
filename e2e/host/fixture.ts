/// <reference types="node" />
// Playwright side of the Terminal test host: bundles and serves the host page
// (./page.ts) and gives each test a T3Host to drive it.
import { test as base, type FrameLocator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
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
  ThemeInput,
  TopUpStatusWire,
} from "./protocol";
import { buildCheque, parseChequeDeeplink, randomCoins, type ChequeRequest } from "./payer";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

// ── worker-scoped: bundle once, serve once ───────────────────────────────
async function bundleHostPage(): Promise<string> {
  const out = await build({
    entryPoints: [join(__dirname, "page.ts")],
    bundle: true, format: "iife", platform: "browser", target: "chrome120",
    write: false, minify: false, sourcemap: "inline", logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

function hostHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Terminal test host</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body,iframe{width:100%;height:100%;border:0;overflow:hidden}</style></head>
<body><iframe id="product-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" allow="clipboard-read; clipboard-write"></iframe>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

async function serve(html: string): Promise<{ url: string; server: Server }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "permissions-policy": "clipboard-read=*, clipboard-write=*" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

// ── per-test control object ─────────────────────────────────────────────
export class T3Host {
  readonly events: HostEvent[] = [];
  private waiters = new Set<() => void>();
  constructor(readonly page: Page) {}

  /** called from the exposeBinding */
  push(event: HostEvent) { this.events.push(event); this.waiters.forEach((w) => w()); }

  /** Resolve with the first event (past or future) matching `pred`. */
  waitForEvent<T extends HostEvent>(pred: (e: HostEvent) => e is T, { timeout = 30_000, since = 0 } = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.events.slice(since).find(pred);
        if (hit) { cleanup(); resolve(hit); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("T3Host.waitForEvent timed out")); }, timeout);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
  mark(): number { return this.events.length; }

  /** The first event of `type` (past `since`, or future) that matches `where`. */
  next<K extends HostEvent["type"]>(
    type: K,
    where: (e: Extract<HostEvent, { type: K }>) => boolean = () => true,
    opts: { timeout?: number; since?: number } = {},
  ): Promise<Extract<HostEvent, { type: K }>> {
    return this.waitForEvent(
      (e): e is Extract<HostEvent, { type: K }> => e.type === type && where(e as Extract<HostEvent, { type: K }>),
      opts,
    );
  }

  /** Every event of `type` so far. */
  all<K extends HostEvent["type"]>(type: K): Array<Extract<HostEvent, { type: K }>> {
    return this.events.filter((e): e is Extract<HostEvent, { type: K }> => e.type === type);
  }

  private call<A extends unknown[], R>(fn: string, ...args: A): Promise<R> {
    return this.page.evaluate(([f, a]) => (window.__T3_HOST__ as unknown as Record<string, (...x: unknown[]) => unknown>)[f](...a), [fn, args] as const) as Promise<R>;
  }

  productFrame(): FrameLocator { return this.page.frameLocator("#product-frame"); }
  // theme / accounts / storage
  setTheme(t: ThemeInput) { return this.call("setTheme", t); }
  setAccountConnected(c: boolean) { return this.call("setAccountConnected", c); }
  setAccountGetMode(m: AccountGetMode) { return this.call("setAccountGetMode", m); }
  merchantPublicKey(index = 0) { return this.call<[string, number], Hex>("getProductAccount", new URL(PRODUCT_URL).host, index); }
  getStorage<T = unknown>(key: string) { return this.call<[string], T | undefined>("getStorage", key); }
  seedStorage(key: string, json: unknown) { return this.call("seedStorage", key, json); }
  setStorageMode(m: StorageMode) { return this.call("setStorageMode", m); }
  storageKeys() { return this.call<[], string[]>("storageKeys"); }
  setEntropyMode(m: "derive" | "error") { return this.call("setEntropyMode", m); }
  // payments
  setBalance(planck: bigint) { return this.call("setBalance", planck.toString()); }
  setBalanceMode(m: BalanceMode) { return this.call("setBalanceMode", m); }
  queueTopUpAnswer(a: TopUpAnswer, times = 1) { return this.call("queueTopUpAnswer", a, times); }
  setTopUpScript(s: TopUpScript) { return this.call("setTopUpScript", s); }
  emitTopUpStatus(idHex: Hex, s: TopUpStatusWire) { return this.call("emitTopUpStatus", idHex, s); }
  interruptTopUpStatus(idHex: Hex, reason: "NotFound" | { Unknown: string }) { return this.call("interruptTopUpStatus", idHex, reason); }
  forgetTopUp(idHex: Hex) { return this.call("forgetTopUp", idHex); }
  getTopUps() { return this.call<[], TopUpRecord[]>("getTopUps"); }
  /** Live status subscriptions the host holds for `idHex` (stale ones from reloads included). */
  topUpSubscriberCount(idHex: Hex) { return this.call<[Hex], number>("topUpSubscriberCount", idHex); }
  statementSubscriberCount(topicHex: Hex) { return this.call<[Hex], number>("statementSubscriberCount", topicHex); }
  waitForTopUp(opts?: { since?: number; timeout?: number }) {
    return this.waitForEvent((e): e is Extract<HostEvent, { type: "topUp" }> => e.type === "topUp", opts).then((e) => e.record);
  }
  // statements / payer
  injectStatement(topic: Uint8Array, data: Uint8Array) {
    const h = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
    return this.call("injectStatement", [h(topic)], h(data));
  }
  /**
   * The cheque request the terminal is showing. Waits for the QR to carry a
   * cheque deeplink — until the payment-method setting loads it can briefly
   * be the voucher QR.
   */
  async readChequeRequest(timeout = 30_000): Promise<ChequeRequest> {
    const qr = this.productFrame().locator('[data-testid="qr-code"][data-qr-value^="polkadotapp://pay/cheque"]');
    await qr.waitFor({ state: "attached", timeout });
    return parseChequeDeeplink((await qr.getAttribute("data-qr-value"))!);
  }
  /** Decode the QR image on screen, as a phone camera would (zxing-wasm in Node). */
  async scanQr(): Promise<string> {
    const png = await this.productFrame().locator('[data-testid="qr-code"] svg').screenshot();
    return decodeQr(png);
  }
  /** Send a cheque for `req` (or the request on screen), as the customer's app would. */
  async pay(opts: { req?: ChequeRequest; coins?: number; override?: Parameters<typeof buildCheque>[2] } = {}) {
    const req = opts.req ?? (await this.readChequeRequest());
    const coins = randomCoins(opts.coins ?? 2);
    const { topic, data } = buildCheque(req, coins, opts.override);
    await this.injectStatement(topic, data);
    return { req, coins };
  }
  /** Inject a statement with arbitrary data on `id`'s payment topic. */
  injectRaw(topic: Uint8Array, data: Uint8Array) {
    return this.injectStatement(topic, data);
  }
  /**
   * Wait until the product document has stopped reloading: after a location
   * change the frame can be replaced (next dev compiles routes on demand), and
   * anything typed into the old document is lost.
   */
  async settle({ quietMs = 600, timeout = 30_000 } = {}): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = this.page.frames().find((f) => f !== this.page.mainFrame() && f.url().startsWith(PRODUCT_URL));
      if (!frame) { await this.page.waitForTimeout(100); continue; }
      const mark = `${Date.now()}`;
      try {
        await frame.evaluate((m) => { document.documentElement.dataset.e2eMark = m; }, mark);
        await this.page.waitForTimeout(quietMs);
        if ((await frame.evaluate(() => document.documentElement.dataset.e2eMark)) === mark) return;
      } catch { /* replaced mid-check */ }
    }
    throw new Error("T3Host.settle: product frame kept reloading");
  }
  restartProduct(path?: string) { return this.call("restartProduct", path); }
  setPermission(tag: string, granted: boolean) { return this.call("setPermission", tag, granted); }
  getPreimages() { return this.call<[], Array<{ key: Hex; size: number }>>("getPreimages"); }
  /** The stored bytes for `key`, as 0x-hex, or null. */
  getPreimage(key: Hex) { return this.call<[Hex], Hex | null>("getPreimage", key); }
  seedPreimage(valueHex: Hex) { return this.call<[Hex], Hex>("seedPreimage", valueHex); }
  navigations() { return this.events.filter((e) => e.type === "navigate"); }
  permissions() { return this.events.filter((e) => e.type === "permission"); }
}

let zxingReady: Promise<typeof import("zxing-wasm/reader")> | null = null;
async function decodeQr(png: Buffer): Promise<string> {
  zxingReady ??= (async () => {
    const z = await import("zxing-wasm/reader");
    const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    await z.prepareZXingModule({
      overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    return z;
  })();
  const [hit] = await (await zxingReady).readBarcodes(new Uint8Array(png), { formats: ["QRCode"] });
  if (!hit?.text) throw new Error("no QR on screen");
  return hit.text;
}

// ── fixtures ────────────────────────────────────────────────────────────
type HostOptions = Partial<Omit<HostConfig, "productUrl">>;

export const test = base.extend<{ hostOptions: HostOptions; host: T3Host }, { hostServer: { url: string } }>({
  hostServer: [async ({}, use) => {
    const { url, server } = await serve(hostHtml(await bundleHostPage()));
    await use({ url });
    await new Promise((r) => server.close(r));
  }, { scope: "worker" }],

  hostOptions: [{}, { option: true }],

  host: async ({ page, hostServer, hostOptions }, use) => {
    const host = new T3Host(page);
    const config: HostConfig = {
      productUrl: PRODUCT_URL, initialPath: "/", root: "Bob", theme: "light",
      balance: "0", legacyAccounts: false, ...hostOptions,
    };
    // exposeBinding/addInitScript also reach the product iframe; neither sets
    // a host marker, so the product's runtime detection is unaffected.
    await page.exposeBinding("__t3HostEmit", (_src, event: HostEvent) => host.push(event));
    await page.addInitScript((c) => { if (window === window.top) window.__T3_HOST_CONFIG__ = c; }, config);
    await page.goto(hostServer.url);
    await page.waitForFunction(() => !!window.__T3_HOST__);
    await use(host);
  },
});
export { expect } from "@playwright/test";
