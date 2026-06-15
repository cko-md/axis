'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  onDismiss: () => void;
  onEnable: () => void;
  isSupported: boolean;
}

export default function BiometricPrompt({ onDismiss, onEnable, isSupported }: Props) {
  // Mark as prompted regardless of user choice
  useEffect(() => {
    fetch('/api/auth/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ biometric_prompted: true }),
    }).catch(() => {
      // best-effort — don't block UI
    });
  }, []);

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
          Use Face ID / Touch ID for faster sign-in?
        </h2>

        <p
          className="sub"
          style={{ textAlign: 'center', marginBottom: 20, fontSize: 13 }}
        >
          {isSupported
            ? "Sign in with your device’s biometrics next time — no password needed."
            : "Biometric login isn’t available on this browser/device."}
        </p>

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
