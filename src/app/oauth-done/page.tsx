'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

function OAuthDoneInner(): React.ReactElement {
  const params = useSearchParams();
  const provider = params.get('provider') ?? '';
  const status = params.get('status') ?? 'ok';

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage(
        { type: 'oauth-done', provider, status },
        window.location.origin
      );
      window.close();
    } else {
      // Fallback for direct navigation (popup was blocked)
      let dest = '/';
      if (provider === 'spotify') dest = '/listening-vault?connected=1';
      else if (provider === 'google_calendar') dest = '/schedule?connected=google';
      else if (provider === 'mail_gmail' || provider === 'mail_outlook' || provider === 'mail' || provider === 'gmail' || provider === 'outlook') {
        dest = `/mail?connected=${provider}`;
      } else if (provider === 'strava') dest = '/vitality?connected=strava';
      window.location.replace(dest);
    }
  }, [provider, status]);

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
