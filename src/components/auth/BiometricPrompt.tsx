'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { deferFailureCommit } from '@/lib/observability/deferFailureCommit';

interface Props {
  onDismiss: () => void;
  onEnable: () => void;
  isSupported: boolean;
}

function isExpectedPromptWriteDeferral(status: number, payload: unknown) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (status === 401) {
    return (
      (keys.length === 1 &&
        (record.error === 'Unauthenticated' ||
          record.error === 'UNAUTHENTICATED')) ||
      (keys.length === 2 &&
        record.error === 'UNAUTHORIZED' &&
        record.message === 'Sign in required.')
    );
  }
  return (
    status === 403 &&
    keys.length === 2 &&
    record.error === 'MFA_REQUIRED' &&
    record.message === 'Complete two-factor authentication to continue.'
  );
}

export default function BiometricPrompt({ onDismiss, onEnable, isSupported }: Props) {
  const { toast } = useToast();
  const [saveNonce, setSaveNonce] = useState(0);
  const [saveState, setSaveState] = useState<'saving' | 'ready' | 'error'>('saving');
  const generationRef = useRef(0);
  const onDismissRef = useRef(onDismiss);
  const toastRef = useRef(toast);
  onDismissRef.current = onDismiss;
  toastRef.current = toast;

  // Mark the prompt as seen without allowing a navigation-cancelled request to
  // become a stale error or silently hiding a live persistence failure.
  useEffect(() => {
    let alive = true;
    let pageActive = true;
    const controller = new AbortController();
    const generation = ++generationRef.current;
    const isCurrent = () =>
      alive &&
      pageActive &&
      !controller.signal.aborted &&
      generation === generationRef.current;
    const invalidate = () => {
      if (!pageActive) return;
      pageActive = false;
      controller.abort();
    };
    const restore = () => {
      if (document.visibilityState === 'hidden') return;
      const wasInactive = !pageActive;
      pageActive = true;
      if (wasInactive) setSaveNonce((current) => current + 1);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') invalidate();
      else restore();
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('pageshow', restore);
    document.addEventListener('visibilitychange', visibilityChanged);
    setSaveState('saving');

    void (async () => {
      let status: number | null = null;
      try {
        const response = await fetch('/api/auth/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ biometric_prompted: true }),
          signal: controller.signal,
        });
        status = response.status;
        if (!isCurrent()) return;
        if (!response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new Error('Passkey prompt status response was invalid');
          }
          if (!isCurrent()) return;
          if (isExpectedPromptWriteDeferral(response.status, payload)) {
            onDismissRef.current();
            return;
          }
          throw new Error('Passkey prompt status save failed');
        }
        setSaveState('ready');
      } catch (error) {
        await deferFailureCommit();
        if (!isCurrent()) return;
        setSaveState('error');
        Sentry.captureException(new Error('Biometric prompt status save failed'), {
          tags: {
            area: 'auth',
            operation: 'biometric_prompt_status_save',
            status: status === null ? 'network' : String(status),
            error_type: error instanceof Error ? error.name : 'unknown',
          },
        });
        toastRef.current(
          'Could not save passkey prompt status. It may appear again.',
          'error',
          'Security',
        );
      }
    })();

    return () => {
      alive = false;
      controller.abort();
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [saveNonce]);

  if (saveState === 'saving') return null;

  return (
    /* Backdrop */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10, 11, 14, 0.72)',
        backdropFilter: 'blur(4px)',
        padding: 24,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="biometric-title"
    >
      <div
        className="card tick"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 360,
          padding: 28,
        }}
      >
        {/* Icon */}
        <div style={{ textAlign: 'center', marginBottom: 16, fontSize: 32 }}>🔐</div>

        <h2
          id="biometric-title"
          className="hero-title"
          style={{ textAlign: 'center', fontSize: 17, marginBottom: 8 }}
        >
          Use a passkey for faster sign-in?
        </h2>

        <p
          className="sub"
          style={{ textAlign: 'center', marginBottom: 20, fontSize: 13 }}
        >
          {isSupported
            ? "Sign in with your device biometrics or a security key next time — no password needed."
            : "Passkey sign-in isn’t available on this browser/device."}
        </p>

        {saveState === 'ready' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {isSupported && (
              <Button
                variant="primary"
                className="w-full py-2.5"
                onClick={onEnable}
              >
                Enable
              </Button>
            )}
            <Button
              variant="secondary"
              className="w-full py-2.5"
              onClick={onDismiss}
            >
              Not now
            </Button>
          </div>
        ) : (
          <div
            role="alert"
            style={{ marginTop: 12, textAlign: 'center', fontSize: 12 }}
          >
            This prompt status was not saved, so it may appear again.
            <button
              type="button"
              onClick={() => setSaveNonce((current) => current + 1)}
              style={{ display: 'block', margin: '8px auto 0' }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onDismiss}
              style={{ display: 'block', margin: '8px auto 0' }}
            >
              Not now
            </button>
          </div>
        )}

        <p
          style={{
            marginTop: 16,
            fontSize: 11,
            color: 'var(--ink-faint)',
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          You can change this in Control Room → Security
        </p>
      </div>
    </div>
  );
}
