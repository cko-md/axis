"use client";

import Link from "next/link";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useEnvoyCore } from "@/hooks/useEnvoyCore";
import { ENVOY_REGISTRY, getEnvoy } from "@/lib/envoys/registry";
import type { EnvoyWorkItem } from "@/lib/envoys/activeWork";
import styles from "@/components/vector/Vector.module.css";

function WorkRow({ item }: { item: EnvoyWorkItem }) {
  return (
    <article>
      <div>
        <strong>{item.title}</strong>
        <span>
          {item.kind === "approval" ? "Approval" : item.kind === "run" ? "Routine run" : "Task"}
          {" · "}
          {item.statusLabel}
        </span>
      </div>
      <Link className={styles.secondaryLink} href={item.href}>
        Open {item.kind === "approval" ? "approvals" : "tasks"}
      </Link>
    </article>
  );
}

/**
 * Envoy Lab shell (Wave 15.4). Identity selection + a truthful active-work
 * HUD. Appearance never changes Focus/Intel/Ask behavior; this surface
 * intentionally has no AI controls. Starters are honest candidates —
 * generated art arrives in Wave 15.5, so no artwork is claimed here.
 */
export function EnvoyLabModule() {
  const { workView, selection, selectEnvoy } = useEnvoyCore();
  const active = getEnvoy(selection.activeEnvoyId);

  return (
    <div className={styles.gameShell} data-testid="envoy-lab">
      <section className={styles.gameHero}>
        <div className={styles.gameHeroCopy}>
          <div className={styles.eyebrow}>Labs / Envoy Lab</div>
          <h1>Envoys</h1>
          <p className={styles.gameSubtitle}>
            One identity, chosen by you. Appearance never changes what Focus, Intel, or Ask can do.
          </p>
          <StatusCallout kind="info" title="Starter identities are candidates.">
            Generated Envoy art ships in a later wave. Until each package passes its
            deterministic QA, these entries are names and descriptions only — nothing rendered is
            claimed to exist.
          </StatusCallout>
        </div>
      </section>

      <AxisChromePanel className={styles.gameUtilityBar}>
        <div role="group" aria-label="Active Envoy" className={styles.controlGrid} data-testid="envoy-picker">
          {ENVOY_REGISTRY.map((record) => (
            <Button
              key={record.id}
              variant={record.id === selection.activeEnvoyId ? "primary" : "ghost"}
              aria-pressed={record.id === selection.activeEnvoyId}
              data-testid={`envoy-pick-${record.id}`}
              onClick={() => selectEnvoy(record.id)}
            >
              {record.name}
            </Button>
          ))}
        </div>
        <span role="status" data-testid="envoy-selection-state">
          {selection.persistence === "loading"
            ? "Loading saved selection…"
            : selection.persistence === "persisted"
              ? `${active.name} · saved to your owner-scoped profile`
              : selection.persistence === "local-only"
                ? `${active.name} · this session only (local storage is unavailable)`
                : `${active.name} · save failed; the selection applies to this session only`}
        </span>
      </AxisChromePanel>

      <AxisChromePanel className={styles.gameInfoPanel}>
        <div className={styles.sectionHeading}>
          <div><span>Active work</span><h2>What needs you</h2></div>
          {workView.status === "ready" ? (
            <strong data-testid="envoy-attention-count">
              {workView.work.attentionCount.toString().padStart(2, "0")}
            </strong>
          ) : null}
        </div>

        {workView.status === "loading" ? (
          <StatusCallout kind="loading" title="Loading real task, run, and approval records.">
            Counts appear only from actual rows — nothing is estimated.
          </StatusCallout>
        ) : workView.status === "signed-out" ? (
          <StatusCallout kind="setup_required" title="Sign in to see your work.">
            The Envoy HUD projects your own tasks, routine runs, and approvals; there is nothing
            to show without a session.
          </StatusCallout>
        ) : (
          <>
            {workView.work.degradedSections.length > 0 ? (
              <StatusCallout
                kind="error"
                title={`Some sections are unavailable: ${workView.work.degradedSections.join(", ")}.`}
              >
                Unavailable sections are excluded from every count instead of reading as empty.
              </StatusCallout>
            ) : null}
            {workView.work.ranked.length === 0 && workView.work.degradedSections.length === 0 ? (
              <StatusCallout kind="empty" title="Nothing needs your attention.">
                No pending approvals, active tasks, or waiting routine runs exist right now.
              </StatusCallout>
            ) : (
              <div className={styles.saveSlotList} data-testid="envoy-work-list">
                {workView.work.ranked.map((item) => (
                  <WorkRow key={`${item.kind}:${item.id}`} item={item} />
                ))}
              </div>
            )}
          </>
        )}
      </AxisChromePanel>
    </div>
  );
}
