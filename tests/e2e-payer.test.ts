import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { buildCheque, parseChequeDeeplink, randomCoins, topicFor, topUpIdFor } from "../e2e/host/payer";
import { buildPayW3sDeeplink } from "@/lib/payments/coinage/deeplink";
import { decryptStatementData } from "@/lib/payments/coinage/ecies";
import { deriveTopic } from "@/lib/payments/coinage/topic";
import { deriveTopUpId } from "@/lib/payments/coinage/claim";

/**
 * The e2e payer (e2e/host/payer.ts) is an independent implementation of the
 * customer's side of a W3S cheque. These checks keep it in lock-step with the
 * terminal's decrypt side, so an e2e failure means the app, not the test.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function terminalRequest(amount = "12.50") {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { privateKey, id, uri: buildPayW3sDeeplink({ id, amount, publicKey }) };
}

describe("e2e payer", () => {
  it("parses the terminal's cheque deeplink", () => {
    const { uri, id } = terminalRequest("7.5");
    const req = parseChequeDeeplink(uri);
    expect(req.id).toBe(id);
    expect(req.amount).toBe("7.50");
    expect(req.key).toHaveLength(32);
  });

  it("builds a cheque the terminal decrypts, with the coins intact", () => {
    const { uri, privateKey, id } = terminalRequest();
    const req = parseChequeDeeplink(uri);
    const coins = randomCoins(3);
    const { topic, data } = buildCheque(req, coins);
    const { payload } = decryptStatementData(privateKey, data);
    expect(payload.id).toBe(id);
    expect(payload.amount).toBe("12.50");
    expect(payload.coins.map(hex)).toEqual(coins.map(hex));
    expect(hex(topic)).toBe(hex(deriveTopic(id)));
  });

  it("derives the same top-up ids as the claim", () => {
    expect(hex(topUpIdFor("abc123", 1))).toBe(hex(deriveTopUpId("abc123", 1)));
    expect(hex(topUpIdFor("abc123", 2))).toBe(hex(deriveTopUpId("abc123", 2)));
  });
});
