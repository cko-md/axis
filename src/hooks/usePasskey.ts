'use client';

import { useEffect, useState } from 'react';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

export interface PasskeyRegisterResult {
  ok: boolean;
  passkeyId?: string;
  error?: string;
}

export interface PasskeyAuthenticateResult {
  ok: boolean;
  error?: string;
}

export function usePasskey() {
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    setIsSupported(typeof PublicKeyCredential !== 'undefined');
  }, []);

  async function register(deviceName?: string): Promise<PasskeyRegisterResult> {
    try {
      const optRes = await fetch(
        `/api/auth/passkey/register?action=options${deviceName ? `&deviceName=${encodeURIComponent(deviceName)}` : ''}`,
      );
      if (!optRes.ok) {
        const body = await optRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Failed to get registration options' };
      }
      const {
        options,
        ceremonyId,
      }: { options?: PublicKeyCredentialCreationOptionsJSON; ceremonyId?: string } =
        await optRes.json();
      if (!options || !ceremonyId) {
        return { ok: false, error: 'Invalid registration options' };
      }

      const { startRegistration } = await import('@simplewebauthn/browser');
      let attResp;
      try {
        attResp = await startRegistration({ optionsJSON: options });
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

      const verifyRes = await fetch('/api/auth/passkey/register?action=verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: attResp,
          ceremonyId,
          ...(deviceName ? { deviceName } : {}),
        }),
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
      const {
        options,
        ceremonyId,
      }: { options?: PublicKeyCredentialRequestOptionsJSON; ceremonyId?: string } =
        await optRes.json();
      if (!options || !ceremonyId) {
        return { ok: false, error: 'Invalid authentication options' };
      }

      const { startAuthentication } = await import('@simplewebauthn/browser');
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
        body: JSON.stringify({ response: authResp, ceremonyId }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        return { ok: false, error: body.error ?? 'Authentication failed' };
      }
      const { verified } = await verifyRes.json();
      if (!verified) return { ok: false, error: 'Passkey not verified' };
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  return { isSupported, register, authenticate };
}
