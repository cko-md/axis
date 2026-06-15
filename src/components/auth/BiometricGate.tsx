'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import BiometricPrompt from './BiometricPrompt';
import { usePasskey } from '@/hooks/usePasskey';

export default function BiometricGate() {
  const [show, setShow] = useState(false);
  const { isSupported, register } = usePasskey();

  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!alive || !user) return;
      fetch('/api/auth/settings')
        .then((r) => r.json())
        .then((s) => { if (alive && s && !s.biometric_prompted) setShow(true); })
        .catch(() => {});
    });
    return () => { alive = false; };
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
