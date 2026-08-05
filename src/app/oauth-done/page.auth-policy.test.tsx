// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.params,
}));

import { OAuthDoneClient, oauthFailureRecovery } from './OAuthDoneClient';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let originalClose: typeof window.close;

function setOpener(value: { postMessage: ReturnType<typeof vi.fn> } | null) {
  Object.defineProperty(window, 'opener', { configurable: true, value });
}

beforeEach(() => {
  vi.stubGlobal('React', React);
  originalClose = window.close;
  window.close = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  window.close = originalClose;
  setOpener(null);
  vi.unstubAllGlobals();
});

function render(params: Record<string, string>) {
  navigation.params = new URLSearchParams(params);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<OAuthDoneClient />));
  return container;
}

describe('OAuth completion feedback', () => {
  it('posts an exact popup error to the opener and closes without inventing success', () => {
    const postMessage = vi.fn();
    setOpener({ postMessage });

    render({ provider: 'spotify', status: 'error', reason: 'session_expired' });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'oauth-done',
        provider: 'spotify',
        status: 'error',
        reason: 'session_expired',
      },
      window.location.origin,
    );
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('keeps a blocked-popup error visible with a safe sign-in recovery path', () => {
    setOpener(null);
    const container = render({ provider: 'spotify', status: 'error', reason: 'session_expired' });

    expect(container.textContent).toContain('Connection not completed');
    expect(container.textContent).toContain('Your AXIS session expired');
    const recovery = container.querySelector<HTMLAnchorElement>('a');
    expect(recovery?.textContent).toBe('Sign in to AXIS');
    expect(recovery?.getAttribute('href')).toBe('/login?redirect=%2Flistening-vault');
    expect(container.textContent).not.toContain('connected=1');
    expect(window.close).not.toHaveBeenCalled();
  });

  it('uses dedicated recovery routes for MFA and assurance failures', () => {
    expect(oauthFailureRecovery('spotify', 'mfa_required')).toEqual({
      href: '/login?mfa=required&redirect=%2Flistening-vault',
      label: 'Complete sign-in',
    });
    expect(oauthFailureRecovery('spotify', 'assurance_unavailable')).toEqual({
      href: '/login?authError=assurance_unavailable&redirect=%2Flistening-vault',
      label: 'Sign in again',
    });
  });
});
