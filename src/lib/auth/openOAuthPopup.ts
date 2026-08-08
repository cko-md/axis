import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";
import { waitForComposioToolkitActive } from "@/lib/integrations/refreshAfterComposioConnect";
import type { SupportedToolkit } from "@/lib/integrations/composio";

export type OAuthPopupStatus = "ok" | "error";
export type OAuthPopupHandle = { cancel: () => void };
export type DirectOAuthProvider = "spotify" | "strava";

type Completion = (
  provider: string,
  status: OAuthPopupStatus,
  reason?: string,
) => void;

const DIRECT_ENDPOINTS: Record<DirectOAuthProvider, string> = {
  spotify: "/api/spotify/auth",
  strava: "/api/strava?action=auth",
};

const DIRECT_AUTH_HOSTS: Record<DirectOAuthProvider, string> = {
  spotify: "accounts.spotify.com",
  strava: "www.strava.com",
};

function popupFeatures() {
  const width = 480;
  const height = 700;
  const left = Math.max(0, (window.screen.width - width) / 2);
  const top = Math.max(0, (window.screen.height - height) / 2);
  return `width=${width},height=${height},left=${left},top=${top},popup=1,menubar=no,toolbar=no,location=no`;
}

function isCompletionMessage(value: unknown): value is {
  type: "oauth-done";
  provider: string;
  status: OAuthPopupStatus;
  reason?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "oauth-done" &&
    typeof record.provider === "string" &&
    (record.status === "ok" || record.status === "error") &&
    (record.reason === undefined || typeof record.reason === "string")
  );
}

function attachPopupLifecycle(
  popup: Window,
  expectedProvider: string | null,
  isCurrent: () => boolean,
  onDone: Completion,
  onRetire?: () => void,
): OAuthPopupHandle {
  let retired = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const retire = (closePopup: boolean) => {
    if (retired) return;
    retired = true;
    window.removeEventListener("message", onMessage);
    if (interval) clearInterval(interval);
    interval = null;
    onRetire?.();
    if (closePopup && !popup.closed) popup.close();
  };

  const onMessage = (event: MessageEvent) => {
    if (retired || !isCurrent()) return;
    if (event.origin !== window.location.origin || event.source !== popup) return;
    if (!isCompletionMessage(event.data)) return;
    if (expectedProvider && event.data.provider !== expectedProvider) return;
    const { provider, status } = event.data;
    const reason = event.data.reason?.trim() || undefined;
    retire(true);
    if (!isCurrent()) return;
    onDone(provider, status, reason);
  };

  window.addEventListener("message", onMessage);
  interval = setInterval(() => {
    if (!popup.closed) return;
    retire(false);
  }, 250);

  return { cancel: () => retire(true) };
}

export function openOAuthPopup(
  url: string,
  onDone: Completion,
): OAuthPopupHandle {
  const popup = window.open(url, "axis-oauth", popupFeatures());
  if (!popup) {
    window.location.href = url;
    return { cancel: () => undefined };
  }
  return attachPopupLifecycle(popup, null, () => true, onDone);
}

export function openDirectOAuthPopup(options: {
  provider: DirectOAuthProvider;
  subject: string;
  epoch: number;
  isCurrent: (subject: string, epoch: number) => boolean;
  onDone: Completion;
}): OAuthPopupHandle {
  const { provider, subject, epoch, isCurrent, onDone } = options;
  const popup = window.open("about:blank", `axis-oauth-${provider}`, popupFeatures());
  if (!popup) {
    onDone(provider, "error", "popup_blocked");
    return { cancel: () => undefined };
  }

  const current = () => isCurrent(subject, epoch);
  const initiationController = new AbortController();
  const lifecycle = attachPopupLifecycle(
    popup,
    provider,
    current,
    onDone,
    () => initiationController.abort(),
  );

  void (async () => {
    try {
      const response = await subjectBoundFetch(
        subject,
        DIRECT_ENDPOINTS[provider],
        { method: "POST", signal: initiationController.signal },
      );
      if (!current() || popup.closed) return lifecycle.cancel();
      const body = await response.json().catch(() => null) as { url?: unknown } | null;
      if (!current() || popup.closed) return lifecycle.cancel();
      if (!response.ok || typeof body?.url !== "string") {
        lifecycle.cancel();
        onDone(provider, "error", "initiation_failed");
        return;
      }
      const providerUrl = new URL(body.url);
      if (
        providerUrl.protocol !== "https:" ||
        providerUrl.hostname !== DIRECT_AUTH_HOSTS[provider]
      ) {
        lifecycle.cancel();
        onDone(provider, "error", "invalid_authorization_url");
        return;
      }
      popup.location.replace(providerUrl.href);
    } catch (error) {
      lifecycle.cancel();
      if (!current()) return;
      const reason = error instanceof DOMException && error.name === "AbortError"
        ? "cancelled"
        : "initiation_failed";
      onDone(provider, "error", reason);
    }
  })();

  return lifecycle;
}

/**
 * Composio's callback URL cannot be trusted to carry a real success/failure
 * flag — verify the toolkit flipped to ACTIVE before calling onDone('ok').
 */
export function openComposioOAuthPopup(
  toolkit: SupportedToolkit | string,
  onDone: (status: OAuthPopupStatus) => void,
): OAuthPopupHandle {
  return openOAuthPopup(`/api/integrations/composio/connect?toolkit=${toolkit}`, () => {
    void waitForComposioToolkitActive(toolkit).then((active) => {
      onDone(active ? "ok" : "error");
    });
  });
}
