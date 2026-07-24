/**
 * Composio connections often sit in INITIALIZING right after OAuth. The
 * poll-on-read status route nudges them to ACTIVE, but a single client fetch
 * is not enough — mirror the retry pattern used in PeopleModule.
 */
import type { SupportedToolkit } from "./composio";

export type ComposioConnectionRow = {
  id: string;
  toolkit: string;
  status: string;
  account_label?: string | null;
};

const DEAD_STATUSES = new Set(["FAILED", "EXPIRED", "REVOKED"]);

export async function fetchComposioConnections(): Promise<ComposioConnectionRow[]> {
  const res = await fetch("/api/integrations/composio/status", { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { connections?: ComposioConnectionRow[] };
  return data.connections ?? [];
}

/** Poll the status route a few times (any toolkit). */
export async function pollComposioConnectionStatus(
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 2500;
  for (let i = 0; i < attempts; i++) {
    await fetchComposioConnections();
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Wait until a toolkit is ACTIVE, or a dead-end status appears, or we time out. */
export async function waitForComposioToolkitActive(
  toolkit: SupportedToolkit | string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 2500;
  for (let i = 0; i < attempts; i++) {
    const connections = await fetchComposioConnections();
    const matches = connections.filter((c) => c.toolkit === toolkit);
    if (matches.some((c) => c.status === "ACTIVE")) return true;
    if (matches.some((c) => DEAD_STATUSES.has(c.status))) return false;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** Wait for the exact opaque connection attempt, never merely its toolkit. */
export async function waitForComposioConnectionActive(
  connectionId: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 2500;
  for (let i = 0; i < attempts; i++) {
    const connection = (await fetchComposioConnections()).find((candidate) => candidate.id === connectionId);
    if (connection?.status === "ACTIVE") return true;
    if (connection && DEAD_STATUSES.has(connection.status)) return false;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/** Poll until a toolkit is ACTIVE (when given), then run the module refresh callback. */
export function refreshAfterComposioConnect(
  toolkit: SupportedToolkit | string | null,
  onReady: () => void | Promise<void>,
  onFailed?: () => void,
): void {
  void (async () => {
    const ready = toolkit
      ? await waitForComposioToolkitActive(toolkit)
      : (await pollComposioConnectionStatus(), true);
    if (!ready) {
      onFailed?.();
      return;
    }
    await onReady();
  })();
}
