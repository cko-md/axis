/**
 * Composio connections often sit in INITIALIZING right after OAuth. The
 * poll-on-read status route nudges them to ACTIVE, but a single client fetch
 * is not enough — mirror the retry pattern used in PeopleModule.
 */
export async function pollComposioConnectionStatus(
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 2500;
  for (let i = 0; i < attempts; i++) {
    await fetch("/api/integrations/composio/status", { cache: "no-store" }).catch(() => undefined);
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Poll Composio status, then run the module-specific refresh callback. */
export function refreshAfterComposioConnect(onReady: () => void | Promise<void>): void {
  void (async () => {
    await pollComposioConnectionStatus();
    await onReady();
  })();
}
