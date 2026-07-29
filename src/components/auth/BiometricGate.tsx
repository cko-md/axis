'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useState } from 'react';
import BiometricPrompt from './BiometricPrompt';
import { usePasskey } from '@/hooks/usePasskey';
import { useToast } from '@/components/ui/Toast';

export default function BiometricGate() {
  const [show, setShow] = useState(false);
  const { isSupported, register } = usePasskey();
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    void (async () => {
      let responseStatus: number | null = null;
      try {
        // The route verifies the session server-side. A redundant client-side
        // getUser() can log a native fetch rejection during navigation before
        // its caller can handle it.
        const response = await fetch('/api/auth/settings', { signal: controller.signal });
        responseStatus = response.status;
        if (!alive || response.status === 401) return;
        if (!response.ok) throw new Error(`Settings request failed (${response.status})`);

        const settings: unknown = await response.json();
        if (
          typeof settings !== 'object'
          || settings === null
          || typeof (settings as { biometric_prompted?: unknown }).biometric_prompted !== 'boolean'
        ) {
          throw new Error('Settings response was invalid');
        }
        const biometricPrompted = (settings as { biometric_prompted: boolean }).biometric_prompted;
        if (alive && !biometricPrompted) setShow(true);
      } catch (error) {
        // Navigation aborts are expected and are not actionable after unmount.
        if (!alive || controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
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
    };
  }, [toast]);

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
