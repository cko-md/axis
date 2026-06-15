"use client";

import { useState } from "react";

type Step = "start" | "scan" | "verify";

type EnrollData = {
  id: string;
  type: string;
  totp: {
    qrCode: string;
    secret: string;
    uri: string;
  };
};

export function MFASetup({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [step, setStep] = useState<Step>("start");
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEnroll = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "totp" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Enrollment failed. Please try again.");
        return;
      }
      const data: EnrollData = await res.json();
      setEnrollData(data);
      setStep("scan");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const startChallenge = async () => {
    if (!enrollData) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factorId: enrollData.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Could not start verification. Please try again.");
        return;
      }
      const data = await res.json();
      setChallengeId(data.challengeId);
      setStep("verify");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!enrollData || !challengeId) return;
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factorId: enrollData.id, challengeId, code }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Incorrect code. Please try again.");
        return;
      }
      const data = await res.json();
      if (data.verified) {
        onSuccess();
      } else {
        setError("Verification failed. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] w-full";

  if (step === "start") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6, margin: 0 }}>
          Use an authenticator app like Google Authenticator, Duo, or Authy to generate a time-based one-time
          code at sign-in.
        </p>
        {error && (
          <p style={{ fontSize: 12, color: "var(--down)", margin: 0 }}>{error}</p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="savebtn"
            onClick={startEnroll}
            disabled={loading}
          >
            {loading ? "Starting…" : "Set up authenticator app"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-dim)",
              fontSize: 12,
              padding: "9px 14px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === "scan" && enrollData) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6, margin: 0 }}>
          Open Google Authenticator, Duo, or Authy, tap <strong style={{ color: "var(--ink)" }}>+</strong> and
          scan the QR code. Or enter the secret key manually.
        </p>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "12px",
            background: "#fff",
            borderRadius: "var(--r)",
            border: "1px solid var(--line)",
            width: "fit-content",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enrollData.totp.qrCode}
            alt="QR code for authenticator setup"
            width={160}
            height={160}
            style={{ display: "block", imageRendering: "pixelated" }}
          />
        </div>

        <div>
          <p style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-faint)", margin: "0 0 4px" }}>
            Manual entry key
          </p>
          <code
            style={{
              display: "block",
              fontFamily: "var(--mono)",
              fontSize: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              padding: "8px 10px",
              color: "var(--ink)",
              letterSpacing: "0.12em",
              wordBreak: "break-all",
            }}
          >
            {enrollData.totp.secret}
          </code>
        </div>

        {error && (
          <p style={{ fontSize: 12, color: "var(--down)", margin: 0 }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="savebtn"
            onClick={startChallenge}
            disabled={loading}
          >
            {loading ? "Continuing…" : "I've scanned the code"}
          </button>
          <button
            type="button"
            onClick={() => setStep("start")}
            style={{
              background: "none",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-dim)",
              fontSize: 12,
              padding: "9px 14px",
              cursor: "pointer",
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6, margin: 0 }}>
          Enter the 6-digit code shown in your authenticator app to confirm setup.
        </p>

        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => { if (e.key === "Enter") verify(); }}
          className={inputClass}
          style={{ letterSpacing: "0.22em", fontSize: 20, textAlign: "center", fontFamily: "var(--mono)" }}
          autoFocus
          autoComplete="one-time-code"
        />

        {error && (
          <p style={{ fontSize: 12, color: "var(--down)", margin: 0 }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="savebtn"
            onClick={verify}
            disabled={loading || code.length !== 6}
          >
            {loading ? "Verifying…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => { setStep("scan"); setCode(""); setError(null); }}
            style={{
              background: "none",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-dim)",
              fontSize: 12,
              padding: "9px 14px",
              cursor: "pointer",
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return null;
}
