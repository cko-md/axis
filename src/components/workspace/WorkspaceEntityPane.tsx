"use client";

import * as Sentry from "@sentry/nextjs";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { Button } from "@/components/ui/Button";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { isEntityRef, ENTITY_REGISTRY } from "@/lib/entities/registry";
import type {
  EntityPreviewPayload,
  EntityRef,
  ResolvedEntityReference,
} from "@/lib/entities/types";
import type { WorkspaceSecondaryPane } from "@/lib/workspace/types";
import styles from "./Workspace.module.css";

const ENTITY_FRESHNESS_SLA = {
  freshWithinMs: 24 * 60 * 60 * 1_000,
  staleAfterMs: 7 * 24 * 60 * 60 * 1_000,
};

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; payload: EntityPreviewPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeInternalHref(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function isEntitySummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isEntityRef(value.ref) &&
    typeof value.title === "string" &&
    isSafeInternalHref(value.href) &&
    Array.isArray(value.meta) &&
    value.meta.every(
      (item) => isRecord(item) && typeof item.label === "string" && typeof item.value === "string",
    )
  );
}

function isResolvedReference(value: unknown): value is ResolvedEntityReference {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.target)) return false;
  return (
    typeof value.id === "string" &&
    isEntityRef(value.source) &&
    isEntityRef(value.target) &&
    ["related", "supports", "blocks", "mentions"].includes(String(value.relation)) &&
    ["user", "system"].includes(String(value.origin)) &&
    ["outgoing", "backlink"].includes(String(value.direction)) &&
    typeof value.createdAt === "string" &&
    isEntitySummary(value.entity)
  );
}

function isPreviewPayload(value: unknown): value is EntityPreviewPayload {
  if (!isRecord(value)) return false;
  return (
    isEntitySummary(value.entity) &&
    Array.isArray(value.outgoing) &&
    value.outgoing.every(isResolvedReference) &&
    Array.isArray(value.backlinks) &&
    value.backlinks.every(isResolvedReference) &&
    (value.referencesStatus === "ok" || value.referencesStatus === "unavailable")
  );
}

function previewErrorMessage(status: number): string {
  if (status === 401) return "Your session expired. Sign in again to inspect this item.";
  if (status === 404) return "This item is no longer available, or you do not have access to it.";
  if (status === 400) return "This workspace link is invalid. Close the pane and open the item again.";
  return "The item preview could not be loaded. Try again in a moment.";
}

function RelatedItems({
  title,
  items,
  paneId,
  deletingReferenceId,
  onOpen,
  onRemove,
}: {
  title: string;
  items: readonly ResolvedEntityReference[];
  paneId: string;
  deletingReferenceId: string | null;
  onOpen: (ref: EntityRef) => void;
  onRemove: (reference: ResolvedEntityReference) => void;
}) {
  const headingId = `${paneId}-${title.toLowerCase().replace(/\s+/g, "-")}-heading`;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHeading}>
        <h3 id={headingId}>{title}</h3>
        <span className={styles.sectionCount}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className={styles.emptyText}>No {title.toLowerCase()}.</p>
      ) : (
        <ul className={styles.referenceList}>
          {items.map((reference) => {
            const descriptor = ENTITY_REGISTRY[reference.entity.ref.kind];
            const relationLabel = reference.label || reference.relation;
            return (
              <li key={reference.id} className={styles.referenceRow}>
                <button
                  type="button"
                  className={styles.referenceOpen}
                  onClick={() => onOpen(reference.entity.ref)}
                  aria-label={`Open ${reference.entity.title} in this pane`}
                >
                  <span className={styles.referenceTitle}>{reference.entity.title}</span>
                  <span className={styles.referenceMeta}>
                    {descriptor.label} · {relationLabel}
                  </span>
                </button>
                {reference.origin === "user" ? (
                  <button
                    type="button"
                    className={styles.removeReference}
                    onClick={() => onRemove(reference)}
                    disabled={deletingReferenceId === reference.id}
                    aria-label={`Remove reference to ${reference.entity.title}`}
                  >
                    {deletingReferenceId === reference.id ? (
                      <Loader2 size={14} aria-hidden />
                    ) : (
                      <Trash2 size={14} aria-hidden />
                    )}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function WorkspaceEntityPane({
  pane,
  active,
}: {
  pane: WorkspaceSecondaryPane;
  active: boolean;
}) {
  const {
    navigatePane,
    closePane,
    goBack,
    goForward,
    focusPane,
    hrefWithWorkspace,
  } = useWorkspace();
  const { toast } = useToast();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [deletingReferenceId, setDeletingReferenceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const descriptor = ENTITY_REGISTRY[pane.current.kind];

  const endpoint = useMemo(
    () => `/api/entities/${pane.current.kind}/${encodeURIComponent(pane.current.id)}`,
    [pane],
  );

  const loadPreview = useCallback(
    async (signal: AbortSignal) => {
      setLoadState({ status: "loading" });
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        if (signal.aborted) return;
        if (response.status === 204) {
          setLoadState({ status: "empty" });
          return;
        }
        if (!response.ok) {
          if (response.status >= 500) {
            Sentry.captureException(new Error("Workspace entity preview request failed"), {
              tags: {
                area: "workspace",
                operation: "preview",
                entity_kind: pane.current.kind,
                status: String(response.status),
              },
            });
          }
          setLoadState({ status: "error", message: previewErrorMessage(response.status) });
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (!isPreviewPayload(payload)) {
          Sentry.captureException(new Error("Workspace entity preview returned an invalid shape"), {
            tags: { area: "workspace", operation: "preview_parse", entity_kind: pane.current.kind },
          });
          setLoadState({ status: "empty" });
          return;
        }
        setLoadState({ status: "ready", payload });
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        Sentry.captureException(new Error("Workspace entity preview network request failed"), {
          tags: { area: "workspace", operation: "preview_network", entity_kind: pane.current.kind },
        });
        setLoadState({
          status: "error",
          message: "The preview could not reach AXIS. Check your connection and try again.",
        });
      }
    },
    [endpoint, pane],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPreview(controller.signal);
    return () => controller.abort();
  }, [loadPreview, revision]);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("axis:entity-references-changed", refresh);
    return () => window.removeEventListener("axis:entity-references-changed", refresh);
  }, []);

  const runHistoryAction = (action: "back" | "forward" | "close") => {
    const result =
      action === "back"
        ? goBack(pane.id)
        : action === "forward"
          ? goForward(pane.id)
          : closePane(pane.id);
    if (!result.ok) toast("The workspace URL could not be updated.", "error", "Workspace");
  };

  const openRelated = (ref: EntityRef) => {
    const result = navigatePane(pane.id, ref);
    if (!result.ok) {
      toast("The related item could not be opened in this pane.", "error", "Workspace");
      return;
    }
    setActionError(null);
  };

  const removeReference = async (reference: ResolvedEntityReference) => {
    if (reference.origin !== "user") return;
    const confirmed = window.confirm(
      "Remove this reference? The linked items will not be deleted.",
    );
    if (!confirmed) return;

    setDeletingReferenceId(reference.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/entity-references/${encodeURIComponent(reference.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        if (response.status >= 500) {
          Sentry.captureException(new Error("Workspace reference delete request failed"), {
            tags: {
              area: "workspace",
              operation: "reference_delete",
              entity_kind: pane.current.kind,
              status: String(response.status),
            },
          });
        }
        const message =
          response.status === 404
            ? "That reference was already removed. Refreshing the pane."
            : "The reference could not be removed. Try again.";
        setActionError(message);
        toast(message, response.status === 404 ? "warn" : "error", "Workspace");
        if (response.status === 404) {
          window.dispatchEvent(new CustomEvent("axis:entity-references-changed"));
        }
        return;
      }
      toast("Reference removed.", "success", "Workspace");
      window.dispatchEvent(new CustomEvent("axis:entity-references-changed"));
    } catch {
      Sentry.captureException(new Error("Workspace reference delete network request failed"), {
        tags: {
          area: "workspace",
          operation: "reference_delete_network",
          entity_kind: pane.current.kind,
        },
      });
      const message = "The reference could not reach AXIS. Check your connection and try again.";
      setActionError(message);
      toast(message, "error", "Workspace");
    } finally {
      setDeletingReferenceId(null);
    }
  };

  return (
    <article
      className={styles.entityPane}
      aria-labelledby={`workspace-pane-${pane.id}-title`}
      onPointerDown={() => {
        if (!active) focusPane(pane.id);
      }}
    >
      <header className={styles.paneHeader}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => runHistoryAction("back")}
          disabled={pane.back.length === 0}
          aria-label={`Go back in ${descriptor.label} pane`}
        >
          <ArrowLeft size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => runHistoryAction("forward")}
          disabled={pane.forward.length === 0}
          aria-label={`Go forward in ${descriptor.label} pane`}
        >
          <ArrowRight size={15} aria-hidden />
        </button>
        <div className={styles.paneIdentity}>
          <div className={styles.paneKicker}>Evidence pane</div>
          <div className={styles.paneName} id={`workspace-pane-${pane.id}-title`}>
            {loadState.status === "ready" ? loadState.payload.entity.title : descriptor.label}
          </div>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => runHistoryAction("close")}
          aria-label={`Close ${descriptor.label} pane`}
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      {loadState.status === "loading" ? (
        <StatusCallout kind="loading" title={`Loading ${descriptor.label.toLowerCase()}`} className={styles.paneCallout}>
          AXIS is retrieving the owner-scoped preview and related evidence.
        </StatusCallout>
      ) : null}

      {loadState.status === "empty" ? (
        <StatusCallout
          kind="empty"
          title="No preview is available"
          className={styles.paneCallout}
          actionSlot={
            <Button onClick={() => setRevision((value) => value + 1)}>
              <RotateCw size={14} aria-hidden />
              Retry
            </Button>
          }
        >
          The item returned no displayable details. It may have changed since this workspace link was created.
        </StatusCallout>
      ) : null}

      {loadState.status === "error" ? (
        <StatusCallout
          kind="error"
          title="Preview unavailable"
          className={styles.paneCallout}
          actionSlot={
            <Button onClick={() => setRevision((value) => value + 1)}>
              <RotateCw size={14} aria-hidden />
              Retry
            </Button>
          }
        >
          {loadState.message}
        </StatusCallout>
      ) : null}

      {loadState.status === "ready" ? (
        <div className={styles.paneBody}>
          <section className={styles.entityHeader}>
            <div className={styles.entityHeadingRow}>
              <h2 className={styles.entityTitle}>{loadState.payload.entity.title}</h2>
              {loadState.payload.entity.status ? (
                <span className={styles.status}>{loadState.payload.entity.status}</span>
              ) : null}
            </div>
            {loadState.payload.entity.subtitle ? (
              <p className={styles.entitySubtitle}>{loadState.payload.entity.subtitle}</p>
            ) : null}
            {loadState.payload.entity.description ? (
              <p className={styles.entityDescription}>{loadState.payload.entity.description}</p>
            ) : null}
            <FreshnessBadge
              retrievedAt={loadState.payload.entity.updatedAt}
              sla={ENTITY_FRESHNESS_SLA}
            />
            <a
              className={styles.fullPageLink}
              href={hrefWithWorkspace(loadState.payload.entity.href)}
            >
              {descriptor.fullPageSelection ? "Open full page" : `Open ${descriptor.pluralLabel}`}
              <ExternalLink size={13} aria-hidden />
            </a>
          </section>

          {loadState.payload.entity.meta.length > 0 ? (
            <dl className={styles.metaGrid} aria-label="Item metadata">
              {loadState.payload.entity.meta.map((item, index) => (
                <div className={styles.metaItem} key={`${item.label}-${index}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {loadState.payload.referencesStatus === "unavailable" ? (
            <StatusCallout kind="stale" title="Related evidence is temporarily unavailable">
              The item itself is current, but backlinks and references could not be refreshed.
            </StatusCallout>
          ) : null}

          {actionError ? (
            <p className={styles.actionError} role="alert">
              {actionError}
            </p>
          ) : null}

          <RelatedItems
            title="References"
            items={loadState.payload.outgoing}
            paneId={pane.id}
            deletingReferenceId={deletingReferenceId}
            onOpen={openRelated}
            onRemove={removeReference}
          />
          <RelatedItems
            title="Backlinks"
            items={loadState.payload.backlinks}
            paneId={pane.id}
            deletingReferenceId={deletingReferenceId}
            onOpen={openRelated}
            onRemove={removeReference}
          />
        </div>
      ) : null}
    </article>
  );
}
