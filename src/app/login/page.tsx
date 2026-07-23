'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { AxisAtmosphere } from '@/components/ui/axis/AxisAtmosphere';
import { usePasskey } from '@/hooks/usePasskey';
import MFAChallenge from '@/components/auth/MFAChallenge';
import { isPasswordPwned, PWNED_PASSWORD_MESSAGE } from '@/lib/auth/passwordCheck';

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
  const [rememberMe, setRememberMe] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [mfaState, setMfaState] = useState<MFAState | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const mfaBootstrapStarted = useRef(false);

  // This is intentionally set in a passive effect: it only becomes true after
  // React has hydrated the form and attached its event handlers.
  useEffect(() => {
    setClientReady(true);
  }, []);

  // Consent applies to account creation only — clear it whenever we leave signup.
  useEffect(() => {
    if (mode !== 'signup') setAgreed(false);
  }, [mode]);

  // Load persisted remember-me preference. Discoverable credentials can be
  // used from a new browser, so passkey sign-in is shown whenever supported.
  useEffect(() => {
    const stored = localStorage.getItem('axis-remember-me');
    if (stored !== null) setRememberMe(stored === 'true');
  }, []);

  // Persist remember-me preference
  useEffect(() => {
    localStorage.setItem('axis-remember-me', String(rememberMe));
  }, [rememberMe]);

  const getRedirectUrl = useCallback(() => {
    const redirect = searchParams.get('redirect');
    return redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/command';
  }, [searchParams]);

  function handleMFASuccess() {
    router.push(getRedirectUrl());
    router.refresh();
  }

  const startMFAIfRequired = useCallback(async (): Promise<'not-required' | 'started' | 'error'> => {
    const { data: aal, error: aalError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) {
      await supabase.auth.signOut({ scope: 'local' });
      setError('Could not verify two-factor requirements. Please try again.');
      return 'error';
    }
    if (aal?.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') {
      return 'not-required';
    }

    // A remembered device skips the challenge entirely. The trust cookie is
    // httpOnly, so ask the server whether it is present and valid; middleware
    // makes the same check on every request, so skipping here cannot grant
    // access the server would refuse. Any failure falls through to a normal
    // challenge — this probe can only ever remove friction, never add access.
    try {
      const trustRes = await fetch('/api/auth/mfa/trust-device');
      if (trustRes.ok) {
        const trust = await trustRes.json();
        if (trust?.trusted === true) return 'not-required';
      }
    } catch {
      // Fall through to the challenge.
    }

    const { data: factorsData, error: factorsError } =
      await supabase.auth.mfa.listFactors();
    const totp = factorsData?.totp;
    if (factorsError || !totp || totp.length === 0) {
      await supabase.auth.signOut({ scope: 'local' });
      setError('Two-factor authentication is required but no verified factor is available.');
      return 'error';
    }

    const factorId = totp[0].id;
    const { data: challengeData, error: challengeError } =
      await supabase.auth.mfa.challenge({ factorId });
    if (challengeError || !challengeData) {
      await supabase.auth.signOut({ scope: 'local' });
      setError(challengeError?.message ?? 'Failed to start MFA challenge');
      return 'error';
    }

    setMfaState({ factorId, challengeId: challengeData.id });
    return 'started';
  }, [supabase]);

  useEffect(() => {
    if (searchParams.get('authError') === 'assurance_unavailable') {
      setError('Authentication assurance could not be verified. Please sign in again.');
    }
  }, [searchParams]);

  useEffect(() => {
    if (
      searchParams.get('mfa') !== 'required'
      || mfaBootstrapStarted.current
    ) {
      return;
    }
    mfaBootstrapStarted.current = true;

    void (async () => {
      setLoading(true);
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError || !user) {
        setLoading(false);
        setError('Your sign-in session expired. Please sign in again.');
        return;
      }

      const result = await startMFAIfRequired();
      setLoading(false);
      if (result === 'not-required') {
        router.replace(getRedirectUrl());
        router.refresh();
      }
    })();
  }, [getRedirectUrl, router, searchParams, startMFAIfRequired, supabase]);

  async function handlePasskeySignIn() {
    setPasskeyLoading(true);
    setError(null);
    const result = await passkey.authenticate();
    setPasskeyLoading(false);

    if (!result.ok) {
      if (result.error !== 'Cancelled') setError(result.error ?? 'Passkey authentication failed');
      return;
    }

    const { data: { user }, error: sessionError } = await supabase.auth.getUser();
    if (sessionError || !user) {
      await supabase.auth.signOut({ scope: 'local' });
      setError('Passkey session restoration failed');
      return;
    }

    if (await startMFAIfRequired() !== 'not-required') return;

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
      // Defense-in-depth: the button is also disabled until this is checked.
      if (!agreed) {
        setLoading(false);
        setError('Please accept the Terms of Service and Privacy Policy to continue.');
        return;
      }
      if (await isPasswordPwned(password)) {
        setLoading(false);
        setError(PWNED_PASSWORD_MESSAGE);
        return;
      }
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            terms_accepted_at: new Date().toISOString(),
            terms_version: '2026-06-19',
            privacy_version: '2026-06-19',
          },
        },
      });
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
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }
    if (!signInData.session) {
      setLoading(false);
      setError('Sign-in did not create a session. Please try again.');
      return;
    }

    const mfaResult = await startMFAIfRequired();
    if (mfaResult !== 'not-required') {
      setLoading(false);
      return;
    }

    setLoading(false);
    router.push(getRedirectUrl());
    router.refresh();
  }

  const Bg = () => (
    <>
      <AxisAtmosphere />
      <div className="grain" aria-hidden />
    </>
  );

  // MFA challenge overlay
  if (mfaState) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-6">
        <Bg />
        <MFAChallenge
          factorId={mfaState.factorId}
          challengeId={mfaState.challengeId}
          trustDevice={rememberMe}
          onSuccess={handleMFASuccess}
          onCancel={() => {
            void supabase.auth.signOut({ scope: 'local' });
            setMfaState(null);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center p-6"
      data-testid="login-form"
      data-client-ready={clientReady ? 'true' : 'false'}
    >
      <Bg />
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
        {passkey.isSupported && mode === 'signin' && (
          <button
            type="button"
            onClick={handlePasskeySignIn}
            disabled={passkeyLoading}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] transition hover:border-[var(--accent)] disabled:opacity-50"
          >
            <span>🔐</span>
            <span>{passkeyLoading ? 'Authenticating…' : 'Sign in with a passkey'}</span>
          </button>
        )}

        {/* Divider when passkey btn is shown */}
        {passkey.isSupported && mode === 'signin' && (
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
              <label
                title="After a successful two-factor check, this device is trusted for a while and future sign-ins skip the code."
                style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 12, color: 'var(--ink-dim)' }}
              >
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Trust this device
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

          {/* Required consent — gates account creation */}
          {mode === 'signup' && (
            <label
              htmlFor="tos-consent"
              className="flex items-start gap-2 text-[11px] text-[var(--ink-dim)] leading-snug cursor-pointer"
            >
              <input
                id="tos-consent"
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 shrink-0 accent-[var(--accent)]"
              />
              <span>
                I agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">
                  Terms of Service
                </a>{' '}
                and{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">
                  Privacy Policy
                </a>.
              </span>
            </label>
          )}

          {error && <p className="text-xs text-[var(--down)]">{error}</p>}
          {notice && <p className="text-xs text-[var(--up)]">{notice}</p>}

          <Button
            type="submit"
            variant="primary"
            loading={loading}
            disabled={mode === 'signup' && !agreed}
            className="w-full py-2.5"
          >
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

        {/* Subtle legal links — always reachable; signup also has the consent checkbox above */}
        {mode !== 'signup' && (
          <div className="mt-5 flex items-center justify-center gap-2 text-[10px] text-[var(--ink-faint)]">
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--ink-dim)]">
              Terms
            </a>
            <span aria-hidden>·</span>
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--ink-dim)]">
              Privacy
            </a>
          </div>
        )}

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
