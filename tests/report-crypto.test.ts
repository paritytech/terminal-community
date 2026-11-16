import { describe, expect, it } from "vitest";
import {
  DamagedReportError,
  WrongReportKeyError,
  decryptReport,
  encryptReport,
  isEncryptedReport,
  type EncryptedReportV2,
  type EncryptedReportV3,
} from "@/lib/crypto/symmetric-report";
import { deriveLegacyKey, legacyKeyFingerprint, passphraseProblem } from "@/lib/crypto/manual-key";
import { xchachaEncryptPacked } from "@/lib/crypto/primitives";

const PASS = "night shift key";
const META = { date: "2026-11-16", txCount: 2, terminal: "5GrwvaEF5zXb" };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("report encryption (v3)", () => {
  it("round-trips, with a fresh salt and nonce per report and nothing of the key published", async () => {
    const a = await encryptReport('{"x":1}', PASS, META);
    const b = await encryptReport('{"x":1}', PASS, META);
    expect(a.v).toBe(3);
    expect(a.kdf).toMatchObject({ name: "scrypt", N: 2 ** 15, r: 8, p: 1 });
    expect(a.kdf.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.encrypted).not.toBe(b.encrypted);
    expect(a.meta).toMatchObject({ ...META, keyCheck: expect.stringMatching(/^[0-9a-f]{8}$/) });
    // No unsalted fingerprint: the fast guessing oracle is gone.
    expect(a.meta).not.toHaveProperty("keyFingerprint");
    expect(JSON.stringify(a)).not.toContain(legacyKeyFingerprint(PASS));
    expect(await decryptReport(a, PASS)).toBe('{"x":1}');
    expect(isEncryptedReport(a)).toBe(true);
  });

  it("tells a wrong key from a damaged copy", async () => {
    const env = await encryptReport('{"x":1}', PASS, META);
    await expect(decryptReport(env, "day shift key")).rejects.toBeInstanceOf(WrongReportKeyError);
    const flipped = env.encrypted.slice(0, -2) + (env.encrypted.endsWith("00") ? "01" : "00");
    await expect(decryptReport({ ...env, encrypted: flipped }, PASS)).rejects.toBeInstanceOf(DamagedReportError);
  });

  it("refuses an envelope that asks for an unreasonable scrypt cost", async () => {
    const env = await encryptReport('{"x":1}', PASS, META);
    const heavy: EncryptedReportV3 = { ...env, kdf: { ...env.kdf, N: 2 ** 20 } };
    await expect(decryptReport(heavy, PASS)).rejects.toBeInstanceOf(DamagedReportError);
  });
});

describe("legacy v2 reports still open", () => {
  const legacy = (passphrase: string): EncryptedReportV2 => ({
    v: 2,
    encrypted: hex(xchachaEncryptPacked(new TextEncoder().encode('{"old":true}'), deriveLegacyKey(passphrase))),
    meta: { ...META, encryptedAt: "2026-10-01T00:00:00Z", keyFingerprint: legacyKeyFingerprint(passphrase) },
  });

  it("with the phrase they were sealed under", async () => {
    expect(await decryptReport(legacy("key one"), "key one")).toBe('{"old":true}');
  });

  it("and name the key they need otherwise", async () => {
    const err = await decryptReport(legacy("key one"), "key two").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WrongReportKeyError);
    expect((err as WrongReportKeyError).fingerprint).toBe(legacyKeyFingerprint("key one"));
  });
});

describe("passphrase rule", () => {
  it("asks for at least 12 characters", () => {
    expect(passphraseProblem("")).toBe("Passphrase cannot be empty");
    expect(passphraseProblem("   ")).toBe("Passphrase cannot be empty");
    expect(passphraseProblem("key one")).toMatch(/at least 12 characters/);
    expect(passphraseProblem("  short one  ")).toMatch(/at least 12 characters/);
    expect(passphraseProblem("night shift key")).toBeNull();
  });
});
