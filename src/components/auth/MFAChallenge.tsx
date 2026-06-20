'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';

interface Props {
  factorId: string;
  challengeId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function MFAChallenge({ factorId, challengeId, onSuccess, onCancel }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function verify(codeToVerify: string) {
    if (codeToVerify.length !== 6) return;
    setLoading(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId, code: codeToVerify });
    if (verifyError) {
      setError(verifyError.message ?? 'Verification failed. Try again.');
      setLoading(false);
      setCode('');
      inputRef.current?.focus();
      return;
    }
    onSuccess();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(val);
    if (val.length === 6) verify(val);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await verify(code);
  }

  return (
    <div className="card relative z-10 w-full max-w-md tick">
      {/* Header */}
      <div className="mb-6 text-center">
        <div className="font-mono text-[13px] tracking-[0.26em]">
          A<span className="text-[var(--accent)]">XIS</span>
          <sup className="text-[6.5px] text-[var(--accent-2)]">[CKO]</sup>
        </div>
        <h1 className="hero-title mt-3 text-2xl">Two-factor authentication</h1>
        <p className="sub mx-auto mt-2 text-center">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="6-digit verification code"
          value={code}
          onChange={handleChange}
          disabled={loading}
          className="min-h-[44px] rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-3 text-center text-base tracking-[0.4em] text-[var(--ink)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />

        {error && <p className="text-xs text-[var(--down)]">{error}</p>}

        <Button
          type="submit"
          variant="primary"
          loading={loading}
          disabled={code.length !== 6}
          className="w-full py-2.5"
        >
          Verify
        </Button>
      </form>

      <button
        type="button"
        className="mt-4 w-full text-center text-xs text-[var(--ink-dim)] hover:text-[var(--accent)]"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
