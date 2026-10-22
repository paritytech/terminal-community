/**
 * The codec-1 product-account signer: a polkadot-api v3 `TxCreator` whose
 * signature comes from the host's `host_account_create_transaction`.
 *
 * Built with `createHostTxCreator` from `@parity/product-sdk-host/tx-creator`
 * — the SDK's own creator, published apart from its transport for exactly
 * this, so it loads no TrUAPI client. It fills the standard extensions,
 * picks the transaction-extension pipeline the call needs from the runtime
 * metadata, prices fee estimates locally, and hands the finished extension
 * list here; this module only turns that request into the codec-1 wire shape.
 *
 * Why not the wrapper's own `getProductAccountSigner`: it sends
 * `txExtVersion` as the newest extrinsic *format* when the payload names
 * none, which on Asset Hub Next / Individuality (formats [4, 5], pipelines
 * {0}) is 5 — and the Polkadot app rejects it ("Transaction extension version
 * 5 is not supported by runtime", since its PR #1004). The SDK's creator
 * always names the pipeline, so the host gets 0 there.
 */

"use client";

import { hostApi } from "@novasamatech/host-api-wrapper";
import { assertEnumVariant, derivationIndexOf, enumValue, fromHex, toHex } from "@novasamatech/host-api";
import { createHostTxCreator, type HostTxRequest } from "@parity/product-sdk-host/tx-creator";
import type { HostProductAccount, HostTxCreator } from "./connection";

const UNSUPPORTED_VERSION_ERROR = "Unsupported message version";

export type CreateTransactionApi = Pick<typeof hostApi, "createTransaction">;

/** The SDK creator's request as the codec-1 `createTransaction` payload. */
export function toCreateTransactionPayload(account: HostProductAccount, request: HostTxRequest) {
  const signer: [string, ReturnType<typeof derivationIndexOf>] = [
    account.dotNsIdentifier,
    derivationIndexOf(account.derivationIndex),
  ];
  return {
    signer,
    genesisHash: request.genesisHash,
    callData: fromHex(request.callData),
    extensions: request.extensions.map(({ id, extra, additionalSigned }) => ({
      id,
      extra: fromHex(extra),
      additionalSigned: fromHex(additionalSigned),
    })),
    txExtVersion: request.txExtVersion,
  };
}

export function createProductAccountTxCreator(
  account: HostProductAccount,
  signBytes: (data: Uint8Array) => Promise<Uint8Array>,
  api: CreateTransactionApi = hostApi,
): HostTxCreator {
  return createHostTxCreator(
    account.publicKey,
    async (request) => {
      const response = await api.createTransaction(
        enumValue("v1", toCreateTransactionPayload(account, request)),
      );
      return response.match(
        (ok) => {
          assertEnumVariant(ok, "v1", UNSUPPORTED_VERSION_ERROR);
          return toHex(ok.value) as `0x${string}`;
        },
        (err) => {
          assertEnumVariant(err, "v1", UNSUPPORTED_VERSION_ERROR);
          throw err.value;
        },
      );
    },
    signBytes,
  );
}
