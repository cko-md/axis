import { waitForComposioToolkitActive } from "@/lib/integrations/refreshAfterComposioConnect";
import type { SupportedToolkit } from "@/lib/integrations/composio";

export function openOAuthPopup(
  url: string,
  onDone: (provider: string, status: 'ok' | 'error', reason?: string) => void
): void {
  const w = 480, h = 700;
  const left = Math.max(0, (window.screen.width - w) / 2);
  const top = Math.max(0, (window.screen.height - h) / 2);
  const popup = window.open(
    url,
    'axis-oauth',
    `width=${w},height=${h},left=${left},top=${top},popup=1,menubar=no,toolbar=no,location=no`
  );
  if (!popup) {
    // Fallback: browsers that block popups
    window.location.href = url;
    return;
  }
  function handler(e: MessageEvent) {
    if (e.data?.type !== 'oauth-done') return;
    window.removeEventListener('message', handler);
    onDone(
      e.data.provider as string,
      e.data.status as 'ok' | 'error',
      typeof e.data.reason === 'string' && e.data.reason.length > 0 ? e.data.reason : undefined,
    );
  }
  window.addEventListener('message', handler);
  // Cleanup if popup is closed manually
  const interval = setInterval(() => {
    if (popup.closed) {
      clearInterval(interval);
      window.removeEventListener('message', handler);
    }
  }, 1000);
}

/**
 * Composio's callback URL cannot be trusted to carry a real success/failure
 * flag — verify the toolkit flipped to ACTIVE before calling onDone('ok').
 */
export function openComposioOAuthPopup(
  toolkit: SupportedToolkit | string,
  onDone: (status: 'ok' | 'error') => void,
): void {
  openOAuthPopup(`/api/integrations/composio/connect?toolkit=${toolkit}`, () => {
    void waitForComposioToolkitActive(toolkit).then((active) => {
      onDone(active ? 'ok' : 'error');
    });
  });
}
