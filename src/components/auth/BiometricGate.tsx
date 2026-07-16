'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/client';
import BiometricPrompt from './BiometricPrompt';
import { usePasskey } from '@/hooks/usePasskey';

export default function BiometricGate() {
  const [show, setShow] = useState(false);
  const { isSupported, register } = usePasskey();

  useEffect(() => {
    let alive = true;
    const supabase = createClient();

    void supabase.auth.getUser()
      .then(({ data: { user } }) => {
        if (!alive || !user) return;
        fetch('/api/auth/settings')
          .then(async (response) => {
            if (!response.ok) {
              throw new Error('AUTH_SETTINGS_UNAVAILABLE');
            }
            return response.json();
          })
          .then((s) => { if (alive && s && !s.biometric_prompted) setShow(true); })
          .catch(() => {
            Sentry.captureException(new Error('Biometric prompt settings lookup failed'), {
              tags: {
                area: 'auth',
                operation: 'read_biometric_prompt_settings',
              },
            });
          });
      })
      .catch(() => {
        Sentry.captureException(new Error('Biometric prompt user lookup failed'), {
          tags: {
            area: 'auth',
            operation: 'read_user_for_biometric_prompt',
          },
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  return (
    <BiometricPrompt
      isSupported={isSupported}
      onEnable={async () => {
        setShow(false);
        if (isSupported) await register('This device');
      }}
      onDismiss={() => setShow(false)}
    />
  );
}
