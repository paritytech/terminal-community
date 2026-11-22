import { describe, expect, it } from "vitest";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeW3sEncryptedPayloadV1, encodeW3sPaymentDataV1 } from "@/lib/payments/coinage/codec";
import { NotClaimedError, NothingClaimedError, StatusInterruptedError, TopUpRefusal } from "@/lib/payments/coinage/claim";
import {
  amountsMatch,
  ChequeBook,
  chequeKey,
  creditedNothing,
  matchStatement,
  safeForLog,
  type ChequeEntry,
  type ChequePayload,
} from "@/lib/payments/coinage/cheque-intake";

/**
 * Whatever is posted on the payment topic, the terminal must neither crash
 * nor let one cheque hold the sale hostage: see lib/payments/coinage/cheque-intake.ts.
 */

const terminal = (() => {
  const secretKey = x25519.utils.randomSecretKey();
  return { privateKey: secretKey, publicKey: x25519.getPublicKey(secretKey) };
})();
const PAYMENT_ID = "abc123";

/** The customer app's sender: a cheque sealed to the terminal's QR key. */
function seal(payload: { amount: string; id: string; coins?: Uint8Array[]; timestamp?: bigint }, to = terminal.publicKey) {
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, to);
  const aeadKey = hkdf(sha256, shared, new Uint8Array(0), new Uint8Array(0), 32);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encodeW3sPaymentDataV1({
    amount: payload.amount,
    id: payload.id,
    timestamp: payload.timestamp ?? 1n,
    coins: payload.coins ?? [new Uint8Array(64).fill(3)],
  });
  const sealed = chacha20poly1305(aeadKey, nonce).encrypt(plaintext);
  const encryptedData = new Uint8Array(nonce.length + sealed.length);
  encryptedData.set(nonce);
  encryptedData.set(sealed, nonce.length);
  return encodeW3sEncryptedPayloadV1({ encryptedData, ephemeralPublicKey: ephemeral.publicKey });
}

const match = (data: Uint8Array | undefined, expected = "12.50") =>
  matchStatement(terminal.privateKey, data, PAYMENT_ID, expected);

describe("matchStatement", () => {
  it("takes a cheque for this request", () => {
    const coins = [new Uint8Array(64).fill(5)];
    const m = match(seal({ amount: "12.50", id: PAYMENT_ID, coins }));
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.key).toBe(chequeKey({ coins }));
  });

  it("skips a cheque above the cheque limit instead of throwing", () => {
    // normalizeAmount throws above 10000; that used to escape the statement
    // handler and, on TrUAPI, end the subscription.
    const data = seal({ amount: "99999.00", id: PAYMENT_ID });
    expect(() => match(data)).not.toThrow();
    expect(match(data)).toMatchObject({ ok: false, reason: "amount_mismatch" });
  });

  it("skips every kind of junk with a reason", () => {
    expect(match(undefined)).toMatchObject({ ok: false, reason: "empty" });
    expect(match(new Uint8Array(0))).toMatchObject({ ok: false, reason: "empty" });
    expect(match(crypto.getRandomValues(new Uint8Array(140)))).toMatchObject({ ok: false, reason: "decrypt_failed" });
    const stranger = x25519.getPublicKey(x25519.utils.randomSecretKey());
    expect(match(seal({ amount: "12.50", id: PAYMENT_ID }, stranger))).toMatchObject({ reason: "decrypt_failed" });
    expect(match(seal({ amount: "12.50", id: "other" }))).toMatchObject({ reason: "id_mismatch" });
    expect(match(seal({ amount: "12.00", id: PAYMENT_ID }))).toMatchObject({ reason: "amount_mismatch" });
  });

  it("never puts a stranger's line breaks or long strings into the log line", () => {
    const forged = `x"\n[coinage]   match!\u2028${"A".repeat(500)}`;
    const m = match(seal({ amount: "12.50", id: forged }));
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.detail).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(m.detail.length).toBeLessThan(160);
    expect(m.detail).toMatch(/^id mismatch: got ".*", want "abc123" — skip$/);
  });
});

describe("helpers", () => {
  it("amountsMatch compares in the wire shape and never throws", () => {
    expect(amountsMatch("12.50", "12.50")).toBe(true);
    expect(amountsMatch("012.50", "12.50")).toBe(true);
    expect(amountsMatch("12.51", "12.50")).toBe(false);
    expect(amountsMatch("10000.01", "10000.00")).toBe(false);
    expect(amountsMatch("NaN", "12.50")).toBe(false);
  });

  it("chequeKey tells cheques apart by their coins, not by how they are split", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    expect(chequeKey({ coins: [a, b] })).toBe(chequeKey({ coins: [new Uint8Array([1, 2]), new Uint8Array([3])] }));
    expect(chequeKey({ coins: [a, b] })).not.toBe(chequeKey({ coins: [new Uint8Array([1]), new Uint8Array([2, 3])] }));
    expect(chequeKey({ coins: [a, b] })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("safeForLog quotes, strips control characters and cuts", () => {
    expect(safeForLog("ok")).toBe('"ok"');
    expect(safeForLog("a\nb\u0007c")).toBe('"a?b?c"');
    expect(safeForLog("x".repeat(100), 10)).toBe(`"${"x".repeat(10)}…(100 chars)"`);
  });

  it("creditedNothing is true only for the host's word that nothing landed", () => {
    expect(creditedNothing(new NotClaimedError(1))).toBe(true);
    expect(creditedNothing(new NothingClaimedError())).toBe(true);
    expect(creditedNothing(new TopUpRefusal("InvalidSource"))).toBe(true);
    expect(creditedNothing(new TopUpRefusal("InsufficientFunds"))).toBe(true);
    expect(creditedNothing(new TopUpRefusal("SourceBusy"))).toBe(false);
    expect(creditedNothing(new TopUpRefusal("Unknown", "bridge unavailable"))).toBe(false);
    expect(creditedNothing(new StatusInterruptedError("x"))).toBe(false);
  });
});

describe("ChequeBook", () => {
  const cheque = (n: number): ChequePayload => ({
    amount: "12.50",
    id: PAYMENT_ID,
    timestamp: 1n,
    coins: [new Uint8Array(64).fill(n)],
  });
  const keyed = (n: number) => [cheque(n), `k${n}`] as const;

  function book(capacity = 16) {
    let now = 0;
    const b = new ChequeBook({ capacity, stallMs: 40_000, now: () => now });
    return { b, advance: (ms: number) => void (now += ms) };
  }

  /** The host accepted the claim's registration and its last word is: nothing credited. */
  function nothingCredited(b: ChequeBook, e: ChequeEntry) {
    b.accepted(e, e.lastAttempt!);
    b.fail(e, { attempt: e.lastAttempt!, followed: e.lastAttempt!, settled: true, refusedByHost: false });
  }
  /** The host accepted the claim's registration, then we lost it without a last word. */
  function mayStillCredit(b: ChequeBook, e: ChequeEntry) {
    b.accepted(e, e.lastAttempt!);
    b.fail(e, { attempt: e.lastAttempt!, followed: e.lastAttempt!, settled: false, refusedByHost: false });
  }

  /** Start the next cheque and have the host accept it (waiting for coins). */
  function startDetecting(b: ChequeBook, attempt: number) {
    const entry = b.next().entry!;
    b.start(entry, attempt);
    b.setStage(entry, "detecting");
    return entry;
  }

  it("claims the first cheque at once, and holds the second while the host has not accepted the first", () => {
    const { b, advance } = book();
    expect(b.offer(...keyed(1))).toBe("new");
    expect(b.offer(...keyed(2))).toBe("new");
    const first = b.next().entry!;
    expect(first.key).toBe("k1");
    expect(b.start(first, 1)).toBeNull();
    // Registering: no stall clock at all.
    advance(10 * 60_000);
    expect(b.next()).toEqual({ entry: null, wakeInMs: null });
    expect(b.stalled()).toBe(false);
  });

  it("calls a claim stalled once the host has waited stallMs for its coins, and still starts nothing else", () => {
    const { b, advance } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const first = b.next().entry!;
    b.start(first, 1);
    advance(30_000); // a slow registration does not count
    b.setStage(first, "detecting");
    expect(b.next()).toEqual({ entry: null, wakeInMs: 40_000 });
    advance(39_999);
    expect(b.stalled()).toBe(false);
    advance(1);
    expect(b.stalled()).toBe(true);
    // The host is still on it, and it may yet credit: no second claim.
    expect(b.next()).toEqual({ entry: null, wakeInMs: null });
    advance(60 * 60_000);
    expect(b.next().entry).toBeNull();
  });

  it("never lets another cheque go while a claim's coins are on chain", () => {
    const { b, advance } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const first = startDetecting(b, 1);
    b.setStage(first, "claiming");
    advance(10 * 60_000);
    expect(b.stalled()).toBe(false);
    expect(b.next()).toEqual({ entry: null, wakeInMs: null });
  });

  it("lets the next cheque go at once when the host says a claim credited nothing", () => {
    const { b } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const first = b.next().entry!;
    b.start(first, 1);
    nothingCredited(b, first);
    expect(b.failedCount()).toBe(1);
    expect(b.next().entry?.key).toBe("k2");
  });

  it("holds every other cheque while a failed claim may still be live, until Retry runs that one again", () => {
    const { b } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const first = b.next().entry!;
    b.start(first, 1);
    mayStillCredit(b, first); // e.g. the status subscription dropped for good
    expect(b.next().entry).toBeNull();
    expect(b.blockedByLiveFailure()).toBe(true);
    expect(b.retryFailed()).toBe(1);
    expect(b.next().entry?.key).toBe("k1");
  });

  it("recognises the same cheque again: ignored while it runs, re-tried once it failed", () => {
    const { b } = book();
    b.offer(...keyed(1));
    expect(b.offer(...keyed(1))).toBe("duplicate");
    const first = b.next().entry!;
    b.start(first, 1);
    expect(b.offer(...keyed(1))).toBe("duplicate");
    mayStillCredit(b, first);
    expect(b.offer(...keyed(1))).toBe("again");
    expect(b.offer(...keyed(1))).toBe("duplicate");
    const again = b.next().entry!;
    expect(again.key).toBe("k1");
    // Its second claim knows where its coins were registered before.
    expect(b.start(again, 2)).toBe(1);
    expect(again.runs).toBe(2);
  });

  it("re-runs a re-posted failed cheque only a couple of times; Retry still can", () => {
    const { b } = book();
    b.offer(...keyed(1));
    let attempt = 0;
    const runAndFail = () => {
      const e = b.next().entry!;
      b.start(e, ++attempt);
      nothingCredited(b, e);
    };
    runAndFail();
    expect(b.offer(...keyed(1))).toBe("again");
    runAndFail();
    expect(b.offer(...keyed(1))).toBe("again");
    runAndFail();
    expect(b.offer(...keyed(1))).toBe("exhausted");
    expect(b.next().entry).toBeNull();
    expect(b.retryFailed()).toBe(1);
    expect(b.next().entry?.key).toBe("k1");
  });

  it("tries cheques never claimed before ones asked for again", () => {
    const { b } = book();
    b.offer(...keyed(1));
    const first = b.next().entry!;
    b.start(first, 1);
    nothingCredited(b, first);
    b.offer(...keyed(1)); // again
    b.offer(...keyed(2)); // new
    expect(b.next().entry?.key).toBe("k2");
  });

  it("Retry puts every failed cheque back, and does nothing when none failed", () => {
    const { b } = book();
    expect(b.retryFailed()).toBe(0);
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const one = b.next().entry!;
    b.start(one, 1);
    nothingCredited(b, one);
    const two = b.next().entry!;
    b.start(two, 2);
    mayStillCredit(b, two);
    expect(b.next().entry).toBeNull();
    expect(b.retryFailed()).toBe(2);
    expect(b.failedCount()).toBe(0);
    // The one that may still be live goes first, and alone.
    expect(b.next().entry?.key).toBe("k2");
  });

  it("when full, forgets a failed cheque to take a new one, and drops it only when none failed", () => {
    const { b } = book(2);
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const one = b.next().entry!;
    b.start(one, 1);
    nothingCredited(b, one);
    expect(b.offer(...keyed(3))).toBe("new");
    expect(b.size).toBe(2);
    // k1 is gone; k2 (never tried) and k3 remain.
    expect(b.offer(...keyed(4))).toBe("full");
    expect(b.next().entry?.key).toBe("k2");
  });

  it("never evicts a cheque whose registration may still credit, even when full", () => {
    const { b } = book(3);
    b.offer(...keyed(1));
    const live = b.next().entry!;
    b.start(live, 1);
    mayStillCredit(b, live);
    b.offer(...keyed(2));
    b.offer(...keyed(3));
    expect(b.offer(...keyed(4))).toBe("full");
    expect(b.blockedByLiveFailure()).toBe(true);
    expect(b.next().entry).toBeNull();
  });

  it("keeps a cheque live when a later claim of it is refused without following the earlier registration", () => {
    const { b } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const a = b.next().entry!;
    b.start(a, 1);
    mayStillCredit(b, a); // registration 1 may still credit
    b.retryFailed();
    const again = b.next().entry!;
    expect(b.start(again, 2)).toBe(1);
    // Registration 2 refused outright (coins already spent by registration 1?):
    // that says nothing about registration 1.
    b.fail(again, { attempt: 2, followed: null, settled: true, refusedByHost: true });
    expect(b.blockedByLiveFailure()).toBe(true);
    expect(b.next().entry).toBeNull();
  });

  it("clears a registration only on the host's last word about that very registration", () => {
    const { b } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const a = b.next().entry!;
    b.start(a, 1);
    mayStillCredit(b, a);
    b.retryFailed();
    const again = b.next().entry!;
    b.start(again, 2);
    // SourceBusy: the claim follows registration 1, which ends notClaimed.
    b.accepted(again, 1);
    b.fail(again, { attempt: 2, followed: 1, settled: true, refusedByHost: false });
    expect(b.blockedByLiveFailure()).toBe(false);
    expect(b.next().entry?.key).toBe("k2");
  });

  it("on SourceBusy follows the registration the host last accepted, not the last attempt", () => {
    const { b } = book();
    b.offer(...keyed(1));
    const a = b.next().entry!;
    b.start(a, 1);
    mayStillCredit(b, a);
    b.retryFailed();
    // Run 2 under attempt 2: SourceBusy, follows 1, and is dropped again.
    const run2 = b.next().entry!;
    b.start(run2, 2);
    b.accepted(run2, 1);
    b.fail(run2, { attempt: 2, followed: 1, settled: false, refusedByHost: false });
    b.retryFailed();
    const run3 = b.next().entry!;
    expect(b.start(run3, 3)).toBe(1);
  });

  it("counts a registration as live when the call failed without the host's answer", () => {
    const { b } = book();
    b.offer(...keyed(1));
    b.offer(...keyed(2));
    const a = b.next().entry!;
    b.start(a, 1);
    b.fail(a, { attempt: 1, followed: null, settled: false, refusedByHost: false }); // bridge dropped
    expect(b.blockedByLiveFailure()).toBe(true);
    b.retryFailed();
    expect(b.start(b.next().entry!, 2)).toBe(1);
  });

  it("follows the one running claim, and a claim whose coins are on chain is never stalled", () => {
    const { b, advance } = book();
    expect(b.leader()).toBeNull();
    b.offer(...keyed(1));
    const one = startDetecting(b, 1);
    expect(b.leader()?.key).toBe("k1");
    b.setStage(one, "claiming");
    advance(10 * 60_000);
    expect(b.stalled()).toBe(false);
  });
});
