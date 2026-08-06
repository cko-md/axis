// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createClient: vi.fn(),
  fetch: vi.fn(),
  getUser: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    mocks.createClient();
    return { auth: { getUser: mocks.getUser } };
  },
}));

vi.mock('@/hooks/usePasskey', () => ({
  usePasskey: () => ({ isSupported: false, register: vi.fn() }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('./BiometricPrompt', () => ({
  default: () => 'biometric prompt',
}));

import BiometricGate from './BiometricGate';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

type SettingsResponse = Pick<Response, 'json' | 'ok' | 'status'>;

function promptedResponse(biometricPrompted: boolean): SettingsResponse {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ biometric_prompted: biometricPrompted }),
  };
}

function persistedPageShow() {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { value: true });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  mocks.captureException.mockReset();
  mocks.createClient.mockReset();
  mocks.fetch.mockReset();
  mocks.getUser.mockReset();
  mocks.toast.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BiometricGate settings lookup', () => {
  it('uses the server-authenticated settings route and reports a live network failure safely', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/auth/settings',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Biometric setup settings lookup failed' }),
      expect.objectContaining({
        tags: {
          area: 'auth',
          operation: 'biometric_gate_settings_lookup',
          status: 'network',
          error_type: 'TypeError',
        },
      }),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      'Could not check passkey setup. Please try again.',
      'error',
      'Security',
    );
  });

  it('treats an unauthenticated settings response as signed out without feedback', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: vi.fn(),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('defers silently for the exact middleware MFA assurance response', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({
        error: 'MFA_REQUIRED',
        message: 'Complete two-factor authentication to continue.',
      }),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each([
    ['already prompted', () => promptedResponse(true)],
    ['signed out', () => ({ ok: false, status: 401, json: vi.fn() } satisfies SettingsResponse)],
    ['MFA deferred', () => ({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({
        error: 'MFA_REQUIRED',
        message: 'Complete two-factor authentication to continue.',
      }),
    } satisfies SettingsResponse)],
  ])('clears a pre-BFCache prompt when restored state is %s', async (_case, restoredResponse) => {
    mocks.fetch
      .mockResolvedValueOnce(promptedResponse(false))
      .mockResolvedValueOnce(restoredResponse());

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);
    expect(document.body.textContent).toContain('biometric prompt');

    act(() => window.dispatchEvent(new Event('pagehide')));
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('biometric prompt');

    act(() => window.dispatchEvent(persistedPageShow()));
    await act(flushPromises);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('biometric prompt');
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reports a hostile 403 payload instead of treating it as an MFA deferral', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ error: 'MFA_REQUIRED', message: 'untrusted' }),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Biometric setup settings lookup failed' }),
      expect.objectContaining({
        tags: expect.objectContaining({ status: '403', error_type: 'Error' }),
      }),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      'Could not check passkey setup. Please try again.',
      'error',
      'Security',
    );
  });

  it('reports a malformed successful settings response instead of silently hiding the prompt', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(flushPromises);

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Biometric setup settings lookup failed' }),
      expect.objectContaining({
        tags: expect.objectContaining({ status: '200', error_type: 'Error' }),
      }),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      'Could not check passkey setup. Please try again.',
      'error',
      'Security',
    );
  });

  it('aborts and consumes a navigation-cancelled settings request after unmount', async () => {
    const lookup = deferred<never>();
    mocks.fetch.mockReturnValueOnce(lookup.promise);

    act(() => root?.render(<BiometricGate />));
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    act(() => root?.unmount());
    root = null;

    expect(request.signal?.aborted).toBe(true);
    lookup.reject(new DOMException('The operation was aborted.', 'AbortError'));
    await act(flushPromises);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('aborts and consumes a TypeError that races with pagehide', async () => {
    const lookup = deferred<never>();
    mocks.fetch.mockReturnValueOnce(lookup.promise);

    act(() => root?.render(<BiometricGate />));
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(request.signal?.aborted).toBe(true);
    lookup.reject(new TypeError('same live-looking failure'));
    await act(flushPromises);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('drops a live-looking failure when pagehide wins during deferred commitment', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockRejectedValueOnce(new TypeError('same live-looking failure'));

    act(() => root?.render(<BiometricGate />));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event('pagehide')));
    act(() => vi.runOnlyPendingTimers());
    await act(async () => { await Promise.resolve(); });

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('drops a delayed response body after pagehide without weakening the live malformed-response check', async () => {
    const body = deferred<unknown>();
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(async () => { await Promise.resolve(); });
    act(() => window.dispatchEvent(new Event('pagehide')));
    body.resolve({});
    await act(flushPromises);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
