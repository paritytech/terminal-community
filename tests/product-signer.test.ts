/**
 * The codec-1 product-account signer (lib/host/product-signer.ts): the SDK's
 * `createHostTxCreator`, with the host round trip in the codec-1 shape.
 *
 * What has to hold, against the real Asset Hub Next metadata in .papi
 * (extrinsic formats [4, 5], transaction-extension pipelines {0}):
 *
 *  - the host is asked for `txExtVersion` 0. The wrapper's own creator sends
 *    5 there, which the Polkadot app rejects (its PR #1004) — the reason this
 *    module exists;
 *  - the request reaches `createTransaction` in the wrapper's wire shape:
 *    product account as `[dotNsIdentifier, derivationIndex]`, call data and
 *    extension values as bytes, genesis hash as hex;
 *  - the host's refusal surfaces as its own typed error, and a fee estimate
 *    never reaches the host at all (a host call can prompt the user).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { derivationIndexOf, enumValue } from "@novasamatech/host-api";

// The wrapper boots a sandbox transport on import, which node has no use for.
// Only its `hostApi` default is referenced, and the tests inject their own.
vi.mock("@novasamatech/host-api-wrapper", () => ({ hostApi: {} }));

const { createProductAccountTxCreator, toCreateTransactionPayload } = await import("@/lib/host/product-signer");

const METADATA = `0x${readFileSync(".papi/metadata/paseo_asset_hub.scale").toString("hex")}` as const;
const GENESIS = `0x${"22".repeat(32)}` as const;
const account = { publicKey: new Uint8Array(32).fill(0xaa), dotNsIdentifier: "terminal.dot", derivationIndex: 0 };

/** Every extension pipeline 0 declares, filled with recognisable bytes. */
const plainExtensions = unifyMetadata(decAnyMetadata(METADATA)).extrinsic.extensionsByVersion[0].map(
  ({ identifier }, index) => ({
    id: identifier,
    extra: `0x${index.toString(16).padStart(2, "0")}` as `0x${string}`,
    additionalSigned: "0x" as `0x${string}`,
  }),
);

const payload = {
  version: 1 as const,
  signer: null,
  callData: "0xca11" as `0x${string}`,
  extensions: plainExtensions,
  txExtVersion: null,
  context: {
    metadata: METADATA,
    token: null,
    bestBlockHeight: 1,
    bestBlockHash: `0x${"11".repeat(32)}`,
    genesisHash: GENESIS,
  },
};

function hostAnswering(result: { ok: Uint8Array } | { err: unknown }) {
  return {
    createTransaction: vi.fn(async () => ({
      match: <T,>(ok: (v: unknown) => T, err: (e: unknown) => T) =>
        "ok" in result ? ok(enumValue("v1", result.ok)) : err(enumValue("v1", result.err)),
    })),
  };
}

const signBytes = async () => new Uint8Array(64);

describe("the codec-1 product-account signer", () => {
  it("asks the host for pipeline 0 on Asset Hub Next, in the wrapper's wire shape", async () => {
    const api = hostAnswering({ ok: new Uint8Array([0xde, 0xad]) });
    const creator = createProductAccountTxCreator(account, signBytes, api as never);

    const signed = await creator(payload as never, {} as never, {} as never, false);

    expect(signed).toBe("0xdead");
    expect(api.createTransaction).toHaveBeenCalledTimes(1);
    const [sent] = api.createTransaction.mock.calls[0] as unknown as [{ tag: string; value: Record<string, unknown> }];
    expect(sent.tag).toBe("v1");
    expect(sent.value.txExtVersion).toBe(0);
    expect(sent.value.signer).toEqual(["terminal.dot", derivationIndexOf(0)]);
    expect(sent.value.genesisHash).toBe(GENESIS);
    expect(Array.from(sent.value.callData as Uint8Array)).toEqual([0xca, 0x11]);
    const extensions = sent.value.extensions as Array<{ id: string; extra: Uint8Array }>;
    expect(extensions.map(({ id }) => id)).toEqual(plainExtensions.map(({ id }) => id));
    expect(extensions.every(({ extra }) => extra instanceof Uint8Array)).toBe(true);
  });

  it("surfaces the host's typed refusal", async () => {
    const refusal = new Error("Rejected");
    const creator = createProductAccountTxCreator(account, signBytes, hostAnswering({ err: refusal }) as never);
    await expect(creator(payload as never, {} as never, {} as never, false)).rejects.toBe(refusal);
  });

  it("never asks the host for a fee estimate", async () => {
    const api = hostAnswering({ ok: new Uint8Array([1]) });
    const creator = createProductAccountTxCreator(account, signBytes, api as never);
    const estimate = await creator(payload as never, {} as never, { hasher: vi.fn() } as never, true);
    expect(api.createTransaction).not.toHaveBeenCalled();
    expect(estimate.startsWith("0x")).toBe(true);
  });

  it("carries a named pipeline straight through", () => {
    const sent = toCreateTransactionPayload(account, {
      genesisHash: GENESIS,
      callData: "0x01",
      extensions: [{ id: "CheckNonce", extra: "0x04", additionalSigned: "0x" }],
      txExtVersion: 1,
    });
    expect(sent.txExtVersion).toBe(1);
    expect(Array.from(sent.extensions[0].extra)).toEqual([4]);
    expect(sent.extensions[0].additionalSigned).toHaveLength(0);
  });
});
