'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { usePasskey } from '@/hooks/usePasskey';
import MFAChallenge from '@/components/auth/MFAChallenge';

type Mode = 'signin' | 'signup' | 'forgot-password';

interface MFAState {
  factorId: string;
  challengeId: string;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const passkey = usePasskey();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('signin');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [showPasskeyBtn, setShowPasskeyBtn] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [mfaState, setMfaState] = useState<MFAState | null>(null);

  // Load persisted remember-me preference and passkey availability
  useEffect(() => {
    const stored = localStorage.getItem('axis-remember-me');
    if (stored !== null) setRememberMe(stored === 'true');
    const passkeyRegistered = localStorage.getItem('axis-passkey-registered');
    if (passkeyRegistered === 'true' && passkey.isSupported) setShowPasskeyBtn(true);
  }, [passkey.isSupported]);

  // Persist remember-me preference
  useEffect(() => {
    localStorage.setItem('axis-remember-me', String(rememberMe));
  }, [rememberMe]);

  function getRedirectUrl() {
    const redirect = searchParams.get('redirect');
    return redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/console';
  }

  function handleMFASuccess() {
    router.push(getRedirectUrl());
    router.refresh();
  }

  async function handlePasskeySignIn() {
    setPasskeyLoading(true);
    setError(null);
    const result = await passkey.authenticate();
    setPasskeyLoading(false);

    if (!result.ok) {
      if (result.error !== 'Cancelled') setError(result.error ?? 'Passkey authentication failed');
      return;
    }

    if (result.refreshToken) {
      const { error: refreshError } = await supabase.auth.refreshSession({
        refresh_token: result.refreshToken,
      });
      if (refreshError) {
        setError(refreshError.message);
        return;
      }
    }

    router.push(getRedirectUrl());
    router.refresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);

    // Forgot-password mode
    if (mode === 'forgot-password') {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setLoading(false);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Something went wrong');
      } else {
        setNotice('Check your email for a reset link.');
      }
      return;
    }

    // Sign-up
    if (mode === 'signup') {
      const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
      setLoading(false);
      if (signUpError) { setError(signUpError.message); return; }
      if (!data.session) {
        setNotice('Check your email to confirm your account, then sign in.');
        setMode('signin');
        return;
      }
      router.push(getRedirectUrl());
      router.refresh();
      return;
    }

    // Sign-in
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }

    // If not remembering, mark session as ephemeral for AppShell to handle
    if (!rememberMe) {
      sessionStorage.setItem('axis-session-ephemeral', 'true');
    } else {
      sessionStorage.removeItem('axis-session-ephemeral');
    }

    // Check MFA requirement
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      const totp = factorsData?.totp;
      if (totp && totp.length > 0) {
        const factorId = totp[0].id;
        // Create challenge via API route
        const challengeRes = await fetch('/api/auth/mfa/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ factorId }),
        });
        const challengeData = await challengeRes.json().catch(() => ({}));
        setLoading(false);
        setMfaState({ factorId, challengeId: challengeData.challengeId ?? '' });
        return;
      }
    }

    setLoading(false);
    router.push(getRedirectUrl());
    router.refresh();
  }

  // MFA challenge overlay
  if (mfaState) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-6">
        <div className="grain" aria-hidden />
        <MFAChallenge
          factorId={mfaState.factorId}
          challengeId={mfaState.challengeId}
          onSuccess={handleMFASuccess}
          onCancel={() => setMfaState(null)}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <div className="grain" aria-hidden />
      <div className="card relative z-10 w-full max-w-md tick">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="font-mono text-[13px] tracking-[0.26em]">
            A<span className="text-[var(--accent)]">XIS</span>
            <sup className="text-[6.5px] text-[var(--accent-2)]">[CKO]</sup>
          </div>
          <h1 className="hero-title mt-3 text-2xl">
            {mode === 'signin' && 'Sign in'}
            {mode === 'signup' && 'Create account'}
            {mode === 'forgot-password' && 'Reset password'}
          </h1>
          <p className="sub mx-auto mt-2 text-center">Your personal operating system</p>
        </div>

        {/* Passkey button */}
        {showPasskeyBtn && mode === 'signin' && (
          <button
            type="button"
            onClick={handlePasskeySignIn}
            disabled={passkeyLoading}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] transition hover:border-[var(--accent)] disabled:opacity-50"
          >
            <span>🔐</span>
            <span>{passkeyLoading ? 'Authenticating…' : 'Sign in with Face ID / Touch ID'}</span>
          </button>
        )}

        {/* Divider when passkey btn is shown */}
        {showPasskeyBtn && mode === 'signin' && (
          <div className="mb-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--line)]" />
            <span className="text-[11px] text-[var(--ink-faint)]">or</span>
            <div className="h-px flex-1 bg-[var(--line)]" />
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />

          {mode !== 'forgot-password' && (
            <input
              type="password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            />
          )}

          {/* Remember me / Forgot password row */}
          {mode === 'signin' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: -4 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 12, color: 'var(--ink-dim)' }}>
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Remember me
              </label>
              <button
                type="button"
                onClick={() => { setMode('forgot-password'); setError(null); setNotice(null); }}
                style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Forgot password?
              </button>
            </div>
          )}

          {error && <p className="text-xs text-[var(--down)]">{error}</p>}
          {notice && <p className="text-xs text-[var(--up)]">{notice}</p>}

          <Button type="submit" variant="primary" loading={loading} className="w-full py-2.5">
            {mode === 'signin' && 'Sign in'}
            {mode === 'signup' && 'Create account'}
            {mode === 'forgot-password' && 'Send reset link'}
          </Button>
        </form>

        {/* Footer links */}
        {mode === 'forgot-password' ? (
          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-[var(--ink-dim)] hover:text-[var(--accent)]"
            onClick={() => { setMode('signin'); setError(null); setNotice(null); }}
          >
            Back to sign in
          </button>
        ) : (
          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-[var(--ink-dim)] hover:text-[var(--accent)]"
            onClick={() => { setMode((m) => (m === 'signin' ? 'signup' : 'signin')); setError(null); setNotice(null); }}
          >
            {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
          </button>
        )}

        <p className="mt-6 text-center font-mono text-[9px] text-[var(--ink-faint)]">
          Configure Supabase env vars before signing in.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
