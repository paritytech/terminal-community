/**
 * Bulletin reads and writes, through the host only.
 *
 * Invariants the host integration depends on:
 *  - a silent host (no `preimage_submit_response`) must surface a bounded
 *    timeout error, never an eternal hang;
 *  - the `PreimageSubmit` permission must be requested before the submit slot
 *    is used, otherwise the host drops the request;
 *  - both host clients are used for preimages, each on its own runtime;
 *  - a report the host cannot serve is an error — nothing is fetched from a
 *    public gateway.
 *
 * The host boundary is mocked so the path runs without a real Polkadot app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePreimageSubmitPermission } from "@/lib/host/allowances";
import { fetchJsonFromBulletin, uploadToBulletinChain } from "@/lib/bulletin/client";
import { calculateCID, cidToPreimageKey } from "@/lib/bulletin/cid";

const host = vi.hoisted(() => ({ truapi: false, inHost: true }));
const codec1 = vi.hoisted(() => ({ submit: vi.fn(), lookup: vi.fn() }));
const sdk = vi.hoisted(() => ({ submit: vi.fn(), lookup: vi.fn() }));

vi.mock("@/lib/host/detect", () => ({
  isInHost: () => host.inHost,
  isTruApiRuntime: () => host.truapi,
}));
vi.mock("@/lib/host/allowances", () => ({
  claimDefaultAllowances: vi.fn().mockResolvedValue(undefined),
  ensurePreimageSubmitPermission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@novasamatech/host-api-wrapper", () => ({ preimageManager: codec1 }));
vi.mock("@/lib/host/sdk", () => ({
  loadHostSdk: async () => ({ getPreimageManager: async () => sdk }),
}));

const ensure = vi.mocked(ensurePreimageSubmitPermission);
const fetchSpy = vi.fn();

beforeEach(() => {
  host.truapi = false;
  host.inHost = true;
  for (const m of [codec1.submit, codec1.lookup, sdk.submit, sdk.lookup]) m.mockReset();
  ensure.mockClear();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A lookup that answers with `bytes` (or nothing) once subscribed. */
function answerLookup(mock: typeof codec1.lookup, bytes: Uint8Array | null) {
  mock.mockImplementation((_key: string, cb: (b: Uint8Array | null) => void) => {
    queueMicrotask(() => cb(bytes));
    return { unsubscribe: vi.fn(), onInterrupt: vi.fn() };
  });
}

describe("uploadToBulletinChain", () => {
  it("rejects with a timeout when the host never responds", async () => {
    codec1.submit.mockImplementation(() => new Promise<string>(() => {}));
    vi.useFakeTimers();

    const result = uploadToBulletinChain(new Uint8Array([1, 2, 3]));
    const assertion = expect(result).rejects.toThrow(/timed out/);

    // The submit setTimeout is only registered once the prior awaits settle;
    // pump microtasks until then, then jump past the timeout.
    for (let i = 0; i < 50 && codec1.submit.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(codec1.submit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it("requests PreimageSubmit permission before submitting", async () => {
    codec1.submit.mockResolvedValue("0xabc");

    const result = await uploadToBulletinChain(new Uint8Array([1, 2, 3]));

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(codec1.submit).toHaveBeenCalledTimes(1);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(codec1.submit.mock.invocationCallOrder[0]);
    expect(result.kind).toBe("preimage");
  });

  it("submits through the SDK on the TrUAPI runtime", async () => {
    host.truapi = true;
    sdk.submit.mockResolvedValue("0xabc");
    await uploadToBulletinChain(new Uint8Array([1, 2, 3]));
    expect(sdk.submit).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(codec1.submit).not.toHaveBeenCalled();
  });
});

describe("fetchJsonFromBulletin", () => {
  const report = { day: "2026-11-12", total: 3 };
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  const cid = calculateCID(bytes);

  it("reads the report from the host's preimage store, on either runtime", async () => {
    answerLookup(codec1.lookup, bytes);
    expect(await fetchJsonFromBulletin(cid)).toEqual(report);
    expect(codec1.lookup.mock.calls[0][0]).toBe(cidToPreimageKey(cid));

    host.truapi = true;
    answerLookup(sdk.lookup, bytes);
    expect(await fetchJsonFromBulletin(cid)).toEqual(report);
    expect(sdk.lookup.mock.calls[0][0]).toBe(cidToPreimageKey(cid));
  });

  it("reports a report the host cannot serve, and never goes to a public gateway", async () => {
    answerLookup(codec1.lookup, null);
    vi.useFakeTimers();
    const result = fetchJsonFromBulletin(cid);
    const assertion = expect(result).rejects.toThrow(/could not find this report/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("needs a host", async () => {
    host.inHost = false;
    await expect(fetchJsonFromBulletin(cid)).rejects.toThrow(/Polkadot app/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
