/**
 * Product-account `PolkadotSigner` with a correct `txExtVersion`.
 *
 * We keep the wrapper's key material for `publicKey` / `signBytes` and write
 * `signTx` ourselves: same `host_account_create_transaction` wire call the
 * wrapper makes (`@novasamatech/host-api-wrapper` `accounts.js`
 * `getProductAccountSigner`, `"createTransaction"` mode), field for field,
 * except `txExtVersion` comes from `deriveTxExtVersion` instead of the
 * extrinsic format number. Drop this once the wrapper ships the fix upstream.
 *
 * Since host-api-wrapper 0.10.2 the wrapper's signer is a polkadot-api v3
 * `TxCreator` — a callable with `publicKey` and `signBytes` attached — while
 * this app still drives polkadot-api v2, whose `signSubmitAndWatch` wants a
 * `PolkadotSigner` (`publicKey`, `signTx`, `signBytes`). Only those two
 * members are taken from the base, so both wrapper shapes are accepted.
 */

"use client";

import type { PolkadotSigner } from "polkadot-api";
import { hostApi } from "@novasamatech/host-api-wrapper";
import type { ProductAccount } from "@novasamatech/host-api-wrapper";
import { assertEnumVariant, derivationIndexOf, enumValue, toHex } from "@novasamatech/host-api";
import { deriveTxExtVersion } from "./tx-ext-version";

const UNSUPPORTED_VERSION_ERROR = "Unsupported message version";

export type CreateTransactionApi = Pick<typeof hostApi, "createTransaction">;

/** The part of the wrapper's signer we reuse — same on v2 and v3 shapes. */
export type SignerKeyMaterial = Pick<PolkadotSigner, "publicKey" | "signBytes">;

export function createProductAccountSigner(
  account: ProductAccount,
  base: SignerKeyMaterial,
  api: CreateTransactionApi = hostApi,
): PolkadotSigner {
  return {
    publicKey: base.publicKey,
    signBytes: (data) => base.signBytes(data),
    async signTx(callData, signedExtensions, metadata) {
      const txExtVersion = deriveTxExtVersion(metadata);
      const checkGenesis = signedExtensions["CheckGenesis"];
      if (!checkGenesis) {
        throw new Error("Can't find genesis hash on transaction");
      }
      const response = await api.createTransaction(
        enumValue("v1", {
          signer: [account.dotNsIdentifier, derivationIndexOf(account.derivationIndex)],
          genesisHash: toHex(checkGenesis.additionalSigned),
          callData,
          extensions: Object.values(signedExtensions).map(
            ({ identifier, value, additionalSigned }) => ({
              id: identifier,
              extra: value,
              additionalSigned,
            }),
          ),
          txExtVersion,
        }),
      );
      return response.match(
        (ok) => {
          assertEnumVariant(ok, "v1", UNSUPPORTED_VERSION_ERROR);
          return ok.value;
        },
        (err) => {
          assertEnumVariant(err, "v1", UNSUPPORTED_VERSION_ERROR);
          throw err.value;
        },
      );
    },
  };
}
