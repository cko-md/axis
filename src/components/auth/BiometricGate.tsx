'use client';

import * as Sentry from '@sentry/nextjs';
import React, { useEffect, useState } from 'react';
import BiometricPrompt from './BiometricPrompt';
import { usePasskey } from '@/hooks/usePasskey';
import { useToast } from '@/components/ui/Toast';

function isMfaAssuranceDeferral(payload: unknown) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const entries = Object.entries(payload);
  const body = payload as { error?: unknown; message?: unknown };
  return (
    entries.length === 2
    && body.error === 'MFA_REQUIRED'
    && body.message === 'Complete two-factor authentication to continue.'
  );
}

export default function BiometricGate() {
  const [show, setShow] = useState(false);
  const { isSupported, register } = usePasskey();
  const { toast } = useToast();
  const [lookupNonce, setLookupNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    let pageActive = true;
    const controller = new AbortController();
    const isCurrent = () => alive && pageActive && !controller.signal.aborted;
    const handlePageHide = () => {
      pageActive = false;
      controller.abort();
      setShow(false);
    };
    const handlePageShow = () => {
      const wasInactive = !pageActive;
      pageActive = true;
      if (!wasInactive) return;
      setLookupNonce((current) => current + 1);
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    void (async () => {
      let responseStatus: number | null = null;
      try {
        // The route verifies the session server-side. A redundant client-side
        // getUser() can log a native fetch rejection during navigation before
        // its caller can handle it.
        const response = await fetch('/api/auth/settings', { signal: controller.signal });
        responseStatus = response.status;
        if (!isCurrent()) return;
        if (response.status === 401) {
          setShow(false);
          return;
        }
        if (response.status === 403) {
          const payload: unknown = await response.json();
          if (!isCurrent()) return;
          if (isMfaAssuranceDeferral(payload)) {
            setShow(false);
            return;
          }
          throw new Error('Settings request was forbidden');
        }
        if (!response.ok) throw new Error(`Settings request failed (${response.status})`);

        const settings: unknown = await response.json();
        if (!isCurrent()) return;
        if (
          typeof settings !== 'object'
          || settings === null
          || typeof (settings as { biometric_prompted?: unknown }).biometric_prompted !== 'boolean'
        ) {
          throw new Error('Settings response was invalid');
        }
        const biometricPrompted = (settings as { biometric_prompted: boolean }).biometric_prompted;
        setShow(!biometricPrompted);
      } catch (error) {
        // Navigation aborts are expected and are not actionable after unmount.
        if (!isCurrent() || (error instanceof DOMException && error.name === 'AbortError')) return;
        Sentry.captureException(
          new Error('Biometric setup settings lookup failed'),
          {
            tags: {
              area: 'auth',
              operation: 'biometric_gate_settings_lookup',
              status: responseStatus === null ? 'network' : String(responseStatus),
              error_type: error instanceof Error ? error.name : 'unknown',
            },
          },
        );
        toast('Could not check passkey setup. Please try again.', 'error', 'Security');
      }
    })();

    return () => {
      alive = false;
      controller.abort();
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [lookupNonce, toast]);

  if (!show) return null;

  return (
    <BiometricPrompt
      isSupported={isSupported}
      onEnable={async () => {
        if (!isSupported) return;
        const result = await register('This device');
        if (!result.ok) {
          if (result.error !== 'Cancelled') {
            toast(result.error ?? 'Passkey registration failed', 'error', 'Security');
          }
          return;
        }
        setShow(false);
        toast('Passkey registered', 'success', 'Security');
      }}
      onDismiss={() => setShow(false)}
    />
  );
}
