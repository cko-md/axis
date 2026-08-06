'use client';

import * as Sentry from '@sentry/nextjs';
import React, { useEffect, useRef, useState } from 'react';
import BiometricPrompt from './BiometricPrompt';
import { usePasskey } from '@/hooks/usePasskey';
import { useToast } from '@/components/ui/Toast';

type ActiveSettingsLookup = {
  controller: AbortController;
  generation: number;
  identity: symbol;
};

type PendingSettingsFailure = {
  operation: ActiveSettingsLookup;
  status: number | null;
  errorType: string;
};

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
  const [pendingFailure, setPendingFailure] =
    useState<PendingSettingsFailure | null>(null);
  const generationRef = useRef(0);
  const activeLookupRef = useRef<ActiveSettingsLookup | null>(null);

  useEffect(() => {
    let alive = true;
    let pageActive = true;
    const operation: ActiveSettingsLookup = {
      controller: new AbortController(),
      generation: ++generationRef.current,
      identity: Symbol('biometric-settings-lookup'),
    };
    activeLookupRef.current?.controller.abort();
    activeLookupRef.current = operation;
    setPendingFailure(null);
    const isCurrent = () => {
      const active = activeLookupRef.current;
      return (
        alive
        && pageActive
        && !operation.controller.signal.aborted
        && active === operation
        && active.controller === operation.controller
        && active.identity === operation.identity
        && active.generation === generationRef.current
      );
    };
    const handlePageHide = () => {
      if (!pageActive) return;
      pageActive = false;
      operation.controller.abort();
      if (activeLookupRef.current === operation) activeLookupRef.current = null;
      setPendingFailure((current) =>
        current?.operation === operation ? null : current,
      );
      setShow(false);
    };
    const handlePageShow = () => {
      if (document.visibilityState === 'hidden') return;
      const wasInactive = !pageActive;
      pageActive = true;
      if (!wasInactive) return;
      setLookupNonce((current) => current + 1);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') handlePageHide();
      else handlePageShow();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    void (async () => {
      let responseStatus: number | null = null;
      try {
        // The route verifies the session server-side. A redundant client-side
        // getUser() can log a native fetch rejection during navigation before
        // its caller can handle it.
        const response = await fetch('/api/auth/settings', {
          signal: operation.controller.signal,
        });
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
        setPendingFailure({
          operation,
          status: responseStatus,
          errorType: error instanceof Error ? error.name : 'unknown',
        });
      }
    })();

    return () => {
      alive = false;
      operation.controller.abort();
      if (activeLookupRef.current === operation) activeLookupRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [lookupNonce, toast]);

  useEffect(() => {
    if (!pendingFailure) return;
    const { operation } = pendingFailure;
    const active = activeLookupRef.current;
    if (
      operation.controller.signal.aborted
      || active !== operation
      || active.controller !== operation.controller
      || active.identity !== operation.identity
      || active.generation !== generationRef.current
    ) {
      setPendingFailure(null);
      return;
    }
    Sentry.captureException(
      new Error('Biometric setup settings lookup failed'),
      {
        tags: {
          area: 'auth',
          operation: 'biometric_gate_settings_lookup',
          status: pendingFailure.status === null
            ? 'network'
            : String(pendingFailure.status),
          error_type: pendingFailure.errorType,
        },
      },
    );
    toast('Could not check passkey setup. Please try again.', 'error', 'Security');
    setPendingFailure(null);
  }, [pendingFailure, toast]);

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
