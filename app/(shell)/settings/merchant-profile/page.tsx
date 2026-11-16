"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, ReceiptText, UserRound } from "lucide-react";
import { useMerchantProfile } from "@/lib/config/merchant";
import {
  getManualPassphrase,
  manualKeyFingerprint,
  setManualPassphrase,
  MIN_PASSPHRASE_LENGTH,
} from "@/lib/crypto/manual-key";

/**
 * Read-only view of the saved merchant profile (Settings → Merchant Profile),
 * mirroring the onboarding Review layout. Editing goes through the
 * /merchant flow, which prefills every field from the same stored profile.
 */
export default function MerchantProfilePage() {
  const { profile, completed, isLoading } = useMerchantProfile();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4 shrink-0">
          <Link href="/settings" className="p-2" aria-label="Back to settings">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <span className="text-white text-lg font-semibold">Merchant Profile</span>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-6 pb-6">
          {isLoading ? null : !completed || !profile ? (
            /* Reached by URL without a finished onboarding */
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <p className="text-neutral-400 mb-6">
                No merchant profile yet — set one up to unlock items, reports,
                and terminal security.
              </p>
              <Link
                href="/merchant"
                className="bg-white hover:bg-neutral-100 text-black font-semibold px-6 py-3.5 rounded-2xl transition"
              >
                Become a Merchant
              </Link>
            </div>
          ) : (
            <>
              <SectionLabel icon={UserRound} label="Your details" />
              <div className="space-y-3 mb-7">
                <ReadonlyField label="Full name" value={profile.fullName} />
                <ReadonlyField label="Home address" value={profile.homeAddress} />
                <ReadonlyField label="Phone number" value={profile.phone} />
                <ReadonlyField label="Extra Information" value={profile.extra} />
              </div>

              <SectionLabel icon={ReceiptText} label="Receipt details" />
              <div className="space-y-3 mb-7">
                <ReadonlyField label="Business Name" value={profile.businessName} />
                <ReadonlyField label="Address" value={profile.businessAddress} />
                <ReadonlyField label="Tax ID" value={profile.taxId} />
              </div>

              <SectionLabel icon={KeyRound} label="Encryption password" />
              <EncryptionPasswordSection />

              <div className="flex-1" />
              <Link
                href="/merchant"
                className="mt-8 w-full bg-white hover:bg-neutral-100 text-black font-semibold py-4 rounded-2xl transition text-center"
              >
                Edit profile
              </Link>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Report-encryption password. Each report's key is derived from it with
 * scrypt and a fresh salt (see lib/crypto/symmetric-report.ts) — the
 * fingerprint shown after saving lets two terminals verify they share the
 * same password without revealing it. The secret lives in the manual-key store, never inside the
 * merchant profile JSON.
 */
function EncryptionPasswordSection() {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword(getManualPassphrase() ?? "");
    setFingerprint(manualKeyFingerprint());
  }, []);

  const handleSave = () => {
    setError(null);
    try {
      setManualPassphrase(password);
      setFingerprint(manualKeyFingerprint());
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the password");
    }
  };

  return (
    <div>
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 px-4 py-3 flex items-center gap-3">
        <input
          type={show ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Encryption password"
          autoComplete="off"
          className="flex-1 min-w-0 bg-transparent text-white text-base outline-none placeholder:text-neutral-500"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          className="shrink-0 text-neutral-400 hover:text-white transition"
        >
          {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
        </button>
      </div>

      <p className="text-neutral-500 text-xs mt-2">
        Your reports are encrypted with a key derived from this password. Use at
        least {MIN_PASSPHRASE_LENGTH} characters.
        {fingerprint && (
          <>
            {" "}
            Key fingerprint: <span className="font-mono text-neutral-300">{fingerprint}</span>
          </>
        )}
      </p>
      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}

      <button
        type="button"
        onClick={handleSave}
        disabled={password.trim() === ""}
        className="mt-3 w-full bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-white font-semibold py-3 rounded-2xl transition flex items-center justify-center gap-2"
      >
        {saved ? (
          <>
            <Check className="w-4 h-4" /> Saved
          </>
        ) : (
          "Save password"
        )}
      </button>
    </div>
  );
}

function SectionLabel({ icon: Icon, label }: { icon: typeof UserRound; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-5 h-5 text-white" />
      <span className="text-white font-semibold">{label}</span>
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  const filled = value.trim() !== "";
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 px-4 py-3">
      {filled ? (
        <>
          <p className="text-neutral-500 text-xs mb-0.5">{label}</p>
          <p className="text-white">{value}</p>
        </>
      ) : (
        <p className="text-neutral-500">{label}</p>
      )}
    </div>
  );
}
