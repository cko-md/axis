"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import type { MakeOutboxPublicItem } from "@/lib/integrations/makeOutbox";
import styles from "./ControlRoom.module.css";

const EVENT_LABELS: Record<MakeOutboxPublicItem["event_type"], string> = {
  daily_brief: "Daily brief",
  weekly_recap: "Weekly recap",
  bill_reminder: "Bill reminder",
  budget_alert: "Budget alert",
  anomaly_alert: "Anomaly alert",
  subscription_audit: "Subscription audit",
};

function deliveryState(item: MakeOutboxPublicItem) {
  if (item.status === "pending") return "pending";
  return "broken";
}

function deliveryDetail(item: MakeOutboxPublicItem) {
  const updated = new Date(item.updated_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const reason = item.last_error_code?.replaceAll("_", " ") ?? "awaiting delivery";
  return `${item.status.replaceAll("_", " ")} · ${reason} · ${item.attempt_count} attempt${item.attempt_count === 1 ? "" : "s"} · ${updated}`;
}

export function MakeDeliveryOutboxPanel() {
  const { toast } = useToast();
  const [deliveries, setDeliveries] = useState<MakeOutboxPublicItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/integrations/make/outbox", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as {
        deliveries?: MakeOutboxPublicItem[];
      } | null;
      if (!response.ok) throw new Error("Delivery outbox unavailable");
      setDeliveries(body?.deliveries ?? []);
      setError(null);
    } catch {
      setError("Delivery outbox could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = useCallback(async (item: MakeOutboxPublicItem) => {
    setReplayingId(item.id);
    try {
      const response = await fetch(`/api/integrations/make/outbox/${item.id}/replay`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "REPLAY_FAILED");
      toast(`${EVENT_LABELS[item.event_type]} delivered.`, "success", "Make delivery");
      await load();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "REPLAY_FAILED";
      const message = code === "WEBHOOK_NOT_CONFIGURED"
        ? "The Make scenario is not configured."
        : "Delivery could not be replayed.";
      toast(message, "error", "Make delivery");
      await load();
    } finally {
      setReplayingId(null);
    }
  }, [load, toast]);

  if (loading && deliveries.length === 0) {
    return <StatusCallout kind="loading">Checking delivery state.</StatusCallout>;
  }
  if (error) {
    return (
      <StatusCallout
        kind="error"
        title="Delivery outbox unavailable"
        actionSlot={(
          <button type="button" className={styles.iconAction} onClick={() => void load()} title="Retry">
            <Icon icon={RefreshCw} label="Retry loading Make delivery outbox" />
          </button>
        )}
      >
        {error}
      </StatusCallout>
    );
  }
  if (deliveries.length === 0) {
    return <StatusCallout kind="success">No unresolved Make deliveries.</StatusCallout>;
  }

  return (
    <div aria-label="Unresolved Make deliveries">
      {deliveries.map((item) => (
        <div key={item.id} className={styles.svcRow}>
          <span className={styles.svcDot} data-state={deliveryState(item)} />
          <div className={styles.svcBody}>
            <div className={styles.svcName}>{EVENT_LABELS[item.event_type]}</div>
            <div className={styles.svcDesc}>{deliveryDetail(item)}</div>
          </div>
          <button
            type="button"
            className={styles.svcAction}
            onClick={() => void replay(item)}
            disabled={!item.replayable || replayingId !== null}
            title="Replay delivery"
          >
            <Icon icon={RotateCcw} size="xs" aria-hidden />
            {replayingId === item.id ? "Replaying" : "Replay"}
          </button>
        </div>
      ))}
    </div>
  );
}
