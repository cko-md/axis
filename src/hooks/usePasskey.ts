'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export interface PasskeyRegisterResult {
  ok: boolean;
  passkeyId?: string;
  error?: string;
}

export interface PasskeyAuthenticateResult {
  ok: boolean;
  refreshToken?: string;
  error?: string;
}

export function usePasskey() {
  const isSupported = typeof PublicKeyCredential !== 'undefined';

  async function register(deviceName?: string): Promise<PasskeyRegisterResult> {
    try {
      const optRes = await fetch(
        `/api/auth/passkey/register?action=options${deviceName ? `&deviceName=${encodeURIComponent(deviceName)}` : ''}`,
      );
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Failed to get registration options' };
      }
      const options = await optRes.json();

      let attResp;
      try {
        attResp = await startRegistration({ optionsJSON: options });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // user cancelled, timeout, or other browser-level errors
        if (
          msg.toLowerCase().includes('cancel') ||
          msg.toLowerCase().includes('abort') ||
          msg.toLowerCase().includes('not allowed')
        ) {
          return { ok: false, error: 'Cancelled' };
        }
        return { ok: false, error: msg };
      }

      const verifyRes = await fetch('/api/auth/passkey/register?action=verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attResp, ...(deviceName ? { deviceName } : {}) }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Verification failed' };
      }
      const { verified, passkeyId } = await verifyRes.json();
      if (!verified) return { ok: false, error: 'Passkey not verified' };
      return { ok: true, passkeyId };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async function authenticate(): Promise<PasskeyAuthenticateResult> {
    try {
      const optRes = await fetch('/api/auth/passkey/authenticate?action=options');
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Failed to get authentication options' };
      }
      const options = await optRes.json();

      let authResp;
      try {
        authResp = await startAuthentication({ optionsJSON: options });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.toLowerCase().includes('cancel') ||
          msg.toLowerCase().includes('abort') ||
          msg.toLowerCase().includes('not allowed')
        ) {
          return { ok: false, error: 'Cancelled' };
        }
        return { ok: false, error: msg };
      }

      const verifyRes = await fetch('/api/auth/passkey/authenticate?action=verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: authResp }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Authentication failed' };
      }
      const { verified, userId, refreshToken } = await verifyRes.json();
      if (!verified) return { ok: false, error: 'Passkey not verified' };
      return { ok: true, ...(refreshToken ? { refreshToken } : {}) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async function updateStoredToken(refreshToken: string, credentialId?: string): Promise<void> {
    await fetch('/api/auth/passkey/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, ...(credentialId ? { credentialId } : {}) }),
    });
  }

  return { isSupported, register, authenticate, updateStoredToken };
}
