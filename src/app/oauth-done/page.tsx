'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

function OAuthDoneInner(): React.ReactElement {
  const params = useSearchParams();
  const provider = params.get('provider') ?? '';
  const status = params.get('status') ?? 'ok';
  // Carries WHY a connect failed (denied, state_missing, state_mismatch,
  // not_configured, token_exchange_failed) so the opener can say something
  // truthful instead of appearing to do nothing.
  const reason = params.get('reason') ?? '';
  const attempt = params.get('attempt') ?? '';

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage(
        { type: 'oauth-done', provider, status, reason, attempt },
        window.location.origin
      );
      window.close();
    } else {
      // Fallback for direct navigation (popup was blocked)
      let dest = '/';
      if (provider === 'spotify') dest = '/listening-vault?connected=1';
      else if (provider === 'google_calendar') dest = '/schedule?connected=google';
      else if (provider === 'mail_gmail' || provider === 'mail_outlook' || provider === 'mail' || provider === 'gmail' || provider === 'outlook' || provider === 'composio_gmail' || provider === 'composio_outlook') {
        dest = `/mail?connected=${provider}`;
      } else if (provider === 'strava') dest = '/vitality?connected=strava';
      else if (provider.startsWith('composio_')) dest = '/control-room?connected=composio';
      window.location.replace(dest);
    }
  }, [provider, status, reason, attempt]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif' }}>
      <p>Connecting&hellip;</p>
    </div>
  );
}

export default function OAuthDonePage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif' }}><p>Connecting&hellip;</p></div>}>
      <OAuthDoneInner />
    </Suspense>
  );
}
