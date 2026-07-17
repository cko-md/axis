'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { createClient } from '@/lib/supabase/client';

export interface PasskeyRegisterResult {
  ok: boolean;
  passkeyId?: string;
  error?: string;
}

export interface PasskeyAuthenticateResult {
  ok: boolean;
  error?: string;
}

type CeremonyOptions<T> = {
  options?: T;
  challengeId?: string;
  error?: string;
};

type JsonResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type PasskeyOperationsDependencies = {
  fetcher: (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<JsonResponse>;
  startRegistration: (
    options: PublicKeyCredentialCreationOptionsJSON,
  ) => Promise<RegistrationResponseJSON>;
  startAuthentication: (
    options: PublicKeyCredentialRequestOptionsJSON,
  ) => Promise<AuthenticationResponseJSON>;
  verifySession: () => Promise<boolean>;
  clearSession: () => Promise<void>;
};

type PasskeySupportEnvironment = {
  PublicKeyCredential?: unknown;
  isSecureContext?: boolean;
  navigator?: { credentials?: unknown };
};

export function supportsPasskeys(
  environment: PasskeySupportEnvironment | undefined =
    typeof window === 'undefined' ? undefined : window,
) {
  return Boolean(
    environment
    && environment.isSecureContext !== false
    && typeof environment.PublicKeyCredential !== 'undefined'
    && environment.navigator?.credentials,
  );
}

function browserError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    message.includes('cancel')
    || message.includes('abort')
    || message.includes('not allowed')
  ) {
    return 'Cancelled';
  }
  return fallback;
}

export function createPasskeyOperations(
  dependencies: PasskeyOperationsDependencies,
) {
  async function register(deviceName?: string): Promise<PasskeyRegisterResult> {
    try {
      const optionResponse = await dependencies.fetcher(
        '/api/auth/passkey/register?action=options',
      );
      const optionBody = await optionResponse.json().catch(() => ({})) as CeremonyOptions<
        PublicKeyCredentialCreationOptionsJSON
      >;
      if (!optionResponse.ok || !optionBody.options || !optionBody.challengeId) {
        return {
          ok: false,
          error: optionBody.error ?? 'Failed to start passkey registration',
        };
      }

      let registrationResponse: RegistrationResponseJSON;
      try {
        registrationResponse = await dependencies.startRegistration(optionBody.options);
      } catch (error) {
        return {
          ok: false,
          error: browserError(error, 'Passkey registration could not be completed'),
        };
      }

      const verifyResponse = await dependencies.fetcher(
        '/api/auth/passkey/register?action=verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response: registrationResponse,
            challengeId: optionBody.challengeId,
            ...(deviceName ? { deviceName } : {}),
          }),
        },
      );
      const verifyBody = await verifyResponse.json().catch(() => ({})) as {
        verified?: boolean;
        passkeyId?: string;
        error?: string;
      };
      if (!verifyResponse.ok || !verifyBody.verified || !verifyBody.passkeyId) {
        return {
          ok: false,
          error: verifyBody.error ?? 'Passkey registration failed',
        };
      }

      return { ok: true, passkeyId: verifyBody.passkeyId };
    } catch {
      return { ok: false, error: 'Passkey registration failed' };
    }
  }

  async function authenticate(): Promise<PasskeyAuthenticateResult> {
    try {
      const optionResponse = await dependencies.fetcher(
        '/api/auth/passkey/authenticate?action=options',
      );
      const optionBody = await optionResponse.json().catch(() => ({})) as CeremonyOptions<
        PublicKeyCredentialRequestOptionsJSON
      >;
      if (!optionResponse.ok || !optionBody.options || !optionBody.challengeId) {
        return {
          ok: false,
          error: optionBody.error ?? 'Failed to start passkey authentication',
        };
      }

      let authenticationResponse: AuthenticationResponseJSON;
      try {
        authenticationResponse = await dependencies.startAuthentication(
          optionBody.options,
        );
      } catch (error) {
        return {
          ok: false,
          error: browserError(error, 'Passkey authentication could not be completed'),
        };
      }

      const verifyResponse = await dependencies.fetcher(
        '/api/auth/passkey/authenticate?action=verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response: authenticationResponse,
            challengeId: optionBody.challengeId,
          }),
        },
      );
      const verifyBody = await verifyResponse.json().catch(() => ({})) as {
        verified?: boolean;
        error?: string;
      };
      if (!verifyResponse.ok || !verifyBody.verified) {
        return {
          ok: false,
          error: verifyBody.error ?? 'Passkey authentication failed',
        };
      }

      if (!(await dependencies.verifySession())) {
        await dependencies.clearSession().catch(() => undefined);
        return { ok: false, error: 'Passkey session restoration failed' };
      }

      return { ok: true };
    } catch {
      return { ok: false, error: 'Passkey authentication failed' };
    }
  }

  return { register, authenticate };
}

export function usePasskey() {
  const supabase = useMemo(() => createClient(), []);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    setIsSupported(supportsPasskeys());
  }, []);

  const operations = useMemo(() => createPasskeyOperations({
    fetcher: (input, init) => fetch(input, init),
    startRegistration: async (options) => {
      const { startRegistration } = await import('@simplewebauthn/browser');
      return startRegistration({ optionsJSON: options });
    },
    startAuthentication: async (options) => {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      return startAuthentication({ optionsJSON: options });
    },
    verifySession: async () => {
      const [
        { data: sessionData, error: sessionError },
        { data: userData, error: userError },
      ] = await Promise.all([
        supabase.auth.getSession(),
        supabase.auth.getUser(),
      ]);
      return Boolean(
        !sessionError
        && !userError
        && sessionData.session
        && userData.user
        && sessionData.session.user.id === userData.user.id,
      );
    },
    clearSession: async () => {
      await supabase.auth.signOut({ scope: 'local' });
    },
  }), [supabase]);

  return { isSupported, ...operations };
}
