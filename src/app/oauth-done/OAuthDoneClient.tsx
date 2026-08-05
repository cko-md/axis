'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { describeSpotifyConnectFailure } from '@/lib/spotify/connectFailure';

type OAuthRecovery = {
  href: string;
  label: string;
};

export function oauthFailureRecovery(provider: string, reason: string): OAuthRecovery {
  if (provider !== 'spotify') return { href: '/', label: 'Return to AXIS' };
  if (reason === 'mfa_required') {
    return {
      href: '/login?mfa=required&redirect=%2Flistening-vault',
      label: 'Complete sign-in',
    };
  }
  if (reason === 'assurance_unavailable') {
    return {
      href: '/login?authError=assurance_unavailable&redirect=%2Flistening-vault',
      label: 'Sign in again',
    };
  }
  if (reason === 'session_expired') {
    return {
      href: '/login?redirect=%2Flistening-vault',
      label: 'Sign in to AXIS',
    };
  }
  if (reason === 'auth_unavailable') return { href: '/', label: 'Return to AXIS' };
  return { href: '/listening-vault', label: 'Return to Listening Vault' };
}

export function OAuthDoneClient(): React.ReactElement {
  const params = useSearchParams();
  const provider = params.get('provider') ?? '';
  const status = params.get('status') ?? 'ok';
  // Carries WHY a connect failed (denied, state_missing, state_mismatch,
  // not_configured, token_exchange_failed) so the opener can say something
  // truthful instead of appearing to do nothing.
  const reason = params.get('reason') ?? '';
  const failed = status !== 'ok';
  const recovery = oauthFailureRecovery(provider, reason);

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage(
        { type: 'oauth-done', provider, status, reason },
        window.location.origin,
      );
      window.close();
      return;
    }

    // A blocked popup falls back to full-page navigation. Never translate a
    // failed callback into a success marker; leave this public page visible so
    // the user can recover even after the AXIS session has expired.
    if (failed) return;

    let dest = '/';
    if (provider === 'spotify') dest = '/listening-vault?connected=1';
    else if (provider === 'google_calendar') dest = '/schedule?connected=google';
    else if (provider === 'mail_gmail' || provider === 'mail_outlook' || provider === 'mail' || provider === 'gmail' || provider === 'outlook' || provider === 'composio_gmail' || provider === 'composio_outlook') {
      dest = `/mail?connected=${provider}`;
    } else if (provider === 'strava') dest = '/vitality?connected=strava';
    else if (provider.startsWith('composio_')) dest = '/control-room?connected=composio';
    window.location.replace(dest);
  }, [failed, provider, status, reason]);

  if (failed) {
    const message = provider === 'spotify'
      ? describeSpotifyConnectFailure(reason)
      : 'The account connection was not completed.';
    return (
      <main style={{ display: 'grid', minHeight: '100vh', placeItems: 'center', padding: '2rem', background: '#080b10', color: '#f4f7fb', fontFamily: 'sans-serif' }}>
        <section style={{ width: '100%', maxWidth: '32rem', padding: '2rem', border: '1px solid #29313d', borderRadius: '1rem', background: '#111722' }}>
          <p style={{ margin: '0 0 0.75rem', color: '#95a2b3', fontSize: '0.75rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Connection status</p>
          <h1 style={{ margin: '0 0 0.75rem', fontSize: '1.5rem' }}>Connection not completed</h1>
          <p style={{ margin: '0 0 1.5rem', color: '#c4ccd7', lineHeight: 1.6 }}>{message}</p>
          <a href={recovery.href} style={{ display: 'inline-block', padding: '0.7rem 1rem', borderRadius: '0.6rem', background: '#f4f7fb', color: '#080b10', fontWeight: 600, textDecoration: 'none' }}>
            {recovery.label}
          </a>
        </section>
      </main>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif' }}>
      <p>Connecting&hellip;</p>
    </div>
  );
}
