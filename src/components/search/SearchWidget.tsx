"use client";

import * as Sentry from "@sentry/nextjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useToast } from "@/components/ui/Toast";
import {
  ENTITY_REGISTRY,
  entityRefKey,
  isEntityKind,
  normalizeEntityRef,
} from "@/lib/entities/registry";
import {
  ENTITY_KINDS,
  ENTITY_RELATIONS,
  type EntityKind,
  type EntityPreviewPayload,
  type EntityRef,
  type EntitySearchResponse,
  type EntitySearchResult,
  type EntitySummary,
  type ResolvedEntityReference,
} from "@/lib/entities/types";
import styles from "./SearchWidget.module.css";

type SearchWidgetProps = Readonly<{
  open: boolean;
  onClose: () => void;
}>;

type RequestState = "idle" | "loading" | "ready" | "error";
type FeedbackTone = "neutral" | "success" | "error";
type Feedback = Readonly<{ tone: FeedbackTone; message: string }>;

type AiState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; answer: string }>
  | Readonly<{ status: "error"; message: string }>;

const SEARCH_DEBOUNCE_MS = 260;
const PREVIEW_DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;
const MAX_RESPONSE_TEXT_LENGTH = 20_000;

const KIND_MARKS: Record<EntityKind, string> = {
  note: "□",
  task: "✓",
  agenda_task: "◷",
  person: "○",
  signal: "◈",
  approval: "◇",
  routine_run: "↻",
  account: "▣",
  holding: "△",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown, maxLength = 4_000): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

function parseRef(value: unknown): EntityRef | null {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return null;
  if (!isEntityKind(value.kind)) return null;
  return normalizeEntityRef({ kind: value.kind, id: value.id });
}

function parseSummary(value: unknown): EntitySummary | null {
  if (!isRecord(value)) return null;
  const ref = parseRef(value.ref);
  if (!ref || typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 500) {
    return null;
  }
  if (typeof value.href !== "string" || !value.href.startsWith("/") || value.href.startsWith("//") || value.href.length > 2_048) {
    return null;
  }

  const subtitle = optionalString(value.subtitle, 1_000);
  const description = optionalString(value.description, 8_000);
  const status = optionalString(value.status, 200);
  const updatedAt = optionalString(value.updatedAt, 100);
  if (subtitle === null || description === null || status === null || updatedAt === null || !Array.isArray(value.meta)) {
    return null;
  }

  const meta = value.meta.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.value !== "string") return [];
    if (item.label.length > 120 || item.value.length > 1_000) return [];
    return [{ label: item.label, value: item.value }];
  });
  if (meta.length !== value.meta.length) return null;

  return {
    ref,
    title: value.title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(description !== undefined ? { description } : {}),
    href: value.href,
    ...(status !== undefined ? { status } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    meta,
  };
}

function parseSearchResult(value: unknown): EntitySearchResult | null {
  const summary = parseSummary(value);
  if (!summary || !isRecord(value) || !isRecord(value.ranking)) return null;
  const { ranking } = value;
  if (
    !isFiniteNumber(ranking.text) ||
    !isFiniteNumber(ranking.usage) ||
    !isFiniteNumber(ranking.freshness) ||
    !isFiniteNumber(ranking.total) ||
    !Array.isArray(ranking.reasons) ||
    !ranking.reasons.every((reason) => typeof reason === "string" && reason.length <= 500)
  ) {
    return null;
  }
  return {
    ...summary,
    ranking: {
      text: ranking.text,
      usage: ranking.usage,
      freshness: ranking.freshness,
      total: ranking.total,
      reasons: ranking.reasons,
    },
  };
}

/** Runtime boundary for the client search API; malformed responses are never rendered. */
export function parseEntitySearchResponse(value: unknown): EntitySearchResponse | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.partial !== "boolean") return null;
  if (!Array.isArray(value.results) || !Array.isArray(value.sources) || value.results.length > 25) return null;

  const results = value.results.map(parseSearchResult);
  if (results.some((result) => result === null)) return null;

  const sources = value.sources.map((source) => {
    if (!isRecord(source) || typeof source.kind !== "string") return null;
    if (source.kind !== "usage" && !isEntityKind(source.kind)) return null;
    if (source.status !== "ok" && source.status !== "unavailable") return null;
    if (!Number.isInteger(source.count) || (source.count as number) < 0) return null;
    const code = optionalString(source.code, 120);
    if (code === null) return null;
    return {
      kind: source.kind,
      status: source.status,
      count: source.count as number,
      ...(code !== undefined ? { code } : {}),
    };
  });
  if (sources.some((source) => source === null)) return null;

  return {
    version: 1,
    results: results as EntitySearchResult[],
    sources: sources as EntitySearchResponse["sources"],
    partial: value.partial,
  };
}

function parseResolvedReference(value: unknown): ResolvedEntityReference | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 256) return null;
  const source = parseRef(value.source);
  const target = parseRef(value.target);
  const entity = parseSummary(value.entity);
  if (!source || !target || !entity) return null;
  if (typeof value.relation !== "string" || !ENTITY_RELATIONS.includes(value.relation as never)) return null;
  if (value.origin !== "user" && value.origin !== "system") return null;
  if (value.direction !== "outgoing" && value.direction !== "backlink") return null;
  if (typeof value.createdAt !== "string" || value.createdAt.length > 100) return null;
  const label = optionalString(value.label, 120);
  if (label === null) return null;
  return {
    id: value.id,
    source,
    target,
    relation: value.relation as ResolvedEntityReference["relation"],
    ...(label !== undefined ? { label } : {}),
    origin: value.origin,
    createdAt: value.createdAt,
    entity,
    direction: value.direction,
  };
}

/** Runtime boundary for owner-checked entity previews. */
export function parseEntityPreviewPayload(value: unknown): EntityPreviewPayload | null {
  if (!isRecord(value) || (value.referencesStatus !== "ok" && value.referencesStatus !== "unavailable")) {
    return null;
  }
  const entity = parseSummary(value.entity);
  if (!entity || !Array.isArray(value.outgoing) || !Array.isArray(value.backlinks)) return null;
  const outgoing = value.outgoing.map(parseResolvedReference);
  const backlinks = value.backlinks.map(parseResolvedReference);
  if (outgoing.some((reference) => reference === null) || backlinks.some((reference) => reference === null)) {
    return null;
  }
  return {
    entity,
    outgoing: outgoing as ResolvedEntityReference[],
    backlinks: backlinks as ResolvedEntityReference[],
    referencesStatus: value.referencesStatus,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error("INVALID_JSON_RESPONSE");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function refEquals(left: EntityRef | null, right: EntityRef | null): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
}

function previewErrorMessage(status: number): string {
  if (status === 401) return "Your session expired. Sign in again to preview this item.";
  if (status === 404) return "This item is no longer available or you do not have access.";
  return "Preview is temporarily unavailable. Try again.";
}

function searchErrorMessage(status: number): string {
  if (status === 401) return "Your session expired. Sign in again to search.";
  if (status === 400) return "Check the search text and filters, then try again.";
  return "Entity search is temporarily unavailable. Try again.";
}

export function SearchWidget({ open, onClose }: SearchWidgetProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { currentPaneEntity, hrefWithWorkspace, openEntity } = useWorkspace();
  const [query, setQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<EntityKind>>(() => new Set(ENTITY_KINDS));
  const [searchState, setSearchState] = useState<RequestState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [response, setResponse] = useState<EntitySearchResponse | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchRetry, setSearchRetry] = useState(0);
  const [previewState, setPreviewState] = useState<RequestState>("idle");
  const [preview, setPreview] = useState<EntityPreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [activationBusy, setActivationBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [aiState, setAiState] = useState<AiState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const previewCacheRef = useRef(new Map<string, EntityPreviewPayload>());
  const activationLockRef = useRef(false);

  const results = response?.results ?? [];
  const activeResult = activeIndex >= 0 ? results[activeIndex] ?? null : null;
  const activeOptionId = activeResult ? `axis-search-option-${activeIndex}` : undefined;
  const trimmedQuery = query.trim();

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    invokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => {
      window.clearTimeout(focusTimer);
      const invoker = invokerRef.current;
      invokerRef.current = null;
      if (invoker?.isConnected) window.requestAnimationFrame(() => invoker.focus());
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelectedKinds(new Set(ENTITY_KINDS));
    setSearchState("idle");
    setSearchError(null);
    setResponse(null);
    setActiveIndex(-1);
    setPreviewState("idle");
    setPreview(null);
    setPreviewError(null);
    setFeedback(null);
    setActivationBusy(false);
    setLinkBusy(false);
    setAiState({ status: "idle" });
    activationLockRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClose, open]);

  useEffect(() => {
    setFeedback(null);
    setAiState({ status: "idle" });
  }, [query]);

  useEffect(() => {
    if (!open || trimmedQuery.length < MIN_QUERY_LENGTH || trimmedQuery.length > MAX_QUERY_LENGTH) {
      setSearchState("idle");
      setSearchError(null);
      setResponse(null);
      setActiveIndex(-1);
      return;
    }

    const controller = new AbortController();
    setSearchState("loading");
    setSearchError(null);
    const timer = window.setTimeout(async () => {
      const types = ENTITY_KINDS.filter((kind) => selectedKinds.has(kind)).join(",");
      const params = new URLSearchParams({ q: trimmedQuery, types, limit: "20" });
      try {
        const searchResponse = await fetch(`/api/entities/search?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!searchResponse.ok) throw new Error(`SEARCH_HTTP_${searchResponse.status}`);
        const parsed = parseEntitySearchResponse(await readJson(searchResponse));
        if (!parsed) throw new Error("INVALID_SEARCH_RESPONSE");
        setResponse(parsed);
        setSearchState("ready");
        setActiveIndex(parsed.results.length > 0 ? 0 : -1);
      } catch (error) {
        if (isAbortError(error)) return;
        const status = error instanceof Error && error.message.startsWith("SEARCH_HTTP_")
          ? Number(error.message.slice("SEARCH_HTTP_".length))
          : 0;
        if (status === 0 || status >= 500) {
          Sentry.captureException(new Error("Entity search request failed"), {
            tags: {
              area: "entity_search",
              operation: "search",
              status: status ? String(status) : "network_or_invalid_response",
            },
          });
        }
        setResponse(null);
        setActiveIndex(-1);
        setSearchError(searchErrorMessage(status));
        setSearchState("error");
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchRetry, selectedKinds, trimmedQuery]);

  useEffect(() => {
    if (!open || !activeResult) {
      setPreviewState("idle");
      setPreview(null);
      setPreviewError(null);
      return;
    }

    const key = entityRefKey(activeResult.ref);
    const cached = previewCacheRef.current.get(key);
    if (cached) {
      setPreview(cached);
      setPreviewError(null);
      setPreviewState("ready");
      return;
    }

    const controller = new AbortController();
    setPreview(null);
    setPreviewError(null);
    setPreviewState("loading");
    const timer = window.setTimeout(async () => {
      try {
        const previewResponse = await fetch(
          `/api/entities/${encodeURIComponent(activeResult.ref.kind)}/${encodeURIComponent(activeResult.ref.id)}`,
          { signal: controller.signal, headers: { Accept: "application/json" } },
        );
        if (!previewResponse.ok) throw new Error(`PREVIEW_HTTP_${previewResponse.status}`);
        const parsed = parseEntityPreviewPayload(await readJson(previewResponse));
        if (!parsed || !refEquals(parsed.entity.ref, activeResult.ref)) throw new Error("INVALID_PREVIEW_RESPONSE");
        previewCacheRef.current.set(key, parsed);
        setPreview(parsed);
        setPreviewState("ready");
      } catch (error) {
        if (isAbortError(error)) return;
        const status = error instanceof Error && error.message.startsWith("PREVIEW_HTTP_")
          ? Number(error.message.slice("PREVIEW_HTTP_".length))
          : 0;
        if (status === 0 || status >= 500) {
          Sentry.captureException(new Error("Entity search preview request failed"), {
            tags: {
              area: "entity_search",
              operation: "preview",
              entity_kind: activeResult.ref.kind,
              status: status ? String(status) : "network_or_invalid_response",
            },
          });
        }
        setPreview(null);
        setPreviewError(previewErrorMessage(status));
        setPreviewState("error");
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeResult, open, previewRetry]);

  const recordSearchUsage = useCallback(async (ref: EntityRef): Promise<void> => {
    const usageResponse = await fetch(
      `/api/entities/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}/usage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "search" }),
      },
    );
    if (!usageResponse.ok) {
      throw new Error(`USAGE_HTTP_${usageResponse.status}`);
    }
    const body = await readJson(usageResponse);
    if (!isRecord(body) || body.recorded !== true) {
      throw new Error("INVALID_USAGE_RESPONSE");
    }
  }, []);

  const openInWorkspace = useCallback(async (result: EntitySummary) => {
    if (activationLockRef.current) return;
    activationLockRef.current = true;
    setActivationBusy(true);
    setFeedback({ tone: "neutral", message: `Opening ${result.title}…` });
    try {
      const workspaceResult = openEntity(result.ref);
      if (!workspaceResult.ok) {
        const paneLimit = workspaceResult.code === "PANE_LIMIT";
        const message = paneLimit
          ? "The workspace already has the maximum number of panes. Close a pane and try again."
          : "The workspace URL could not be updated. Try again.";
        setFeedback({ tone: "error", message });
        toast(message, paneLimit ? "warn" : "error", "Workspace");
        return;
      }

      try {
        await recordSearchUsage(result.ref);
      } catch (error) {
        const status =
          error instanceof Error && error.message.startsWith("USAGE_HTTP_")
            ? Number(error.message.slice("USAGE_HTTP_".length))
            : 0;
        if (status === 0 || status >= 500) {
          Sentry.captureException(new Error("Entity search usage write failed"), {
            tags: {
              area: "entity_search",
              operation: "usage_write",
              entity_kind: result.ref.kind,
              status: status ? String(status) : "network_or_invalid_response",
            },
          });
        }
        const message = `${result.title} opened, but search history could not be saved.`;
        setFeedback({ tone: "error", message });
        toast(message, "error", "Search");
        return;
      }
      setFeedback({ tone: "success", message: `${result.title} opened in the workspace.` });
      handleClose();
    } catch {
      Sentry.captureException(new Error("Entity workspace activation failed"), {
        tags: {
          area: "entity_search",
          operation: "workspace_open",
          entity_kind: result.ref.kind,
        },
      });
      const message = "The item could not be opened in the workspace. Try again.";
      setFeedback({ tone: "error", message });
      toast(message, "error", "Workspace");
    } finally {
      activationLockRef.current = false;
      setActivationBusy(false);
    }
  }, [handleClose, openEntity, recordSearchUsage, toast]);

  const openFullPage = useCallback(async (result: EntitySummary) => {
    if (activationLockRef.current) return;
    activationLockRef.current = true;
    setActivationBusy(true);
    setFeedback({ tone: "neutral", message: `Opening ${result.title}…` });
    try {
      try {
        await recordSearchUsage(result.ref);
      } catch (error) {
        const status =
          error instanceof Error && error.message.startsWith("USAGE_HTTP_")
            ? Number(error.message.slice("USAGE_HTTP_".length))
            : 0;
        if (status === 0 || status >= 500) {
          Sentry.captureException(new Error("Entity search usage write failed"), {
            tags: {
              area: "entity_search",
              operation: "usage_write",
              entity_kind: result.ref.kind,
              status: status ? String(status) : "network_or_invalid_response",
            },
          });
        }
        const message = `${result.title} will open, but search history could not be saved.`;
        setFeedback({ tone: "error", message });
        toast(message, "error", "Search");
      }
      router.push(hrefWithWorkspace(result.href));
      handleClose();
    } catch {
      Sentry.captureException(new Error("Entity full-page navigation failed"), {
        tags: {
          area: "entity_search",
          operation: "full_page_navigation",
          entity_kind: result.ref.kind,
        },
      });
      const message = "The full page could not be opened. Try again.";
      setFeedback({ tone: "error", message });
      toast(message, "error", "Search");
    } finally {
      activationLockRef.current = false;
      setActivationBusy(false);
    }
  }, [handleClose, hrefWithWorkspace, recordSearchUsage, router, toast]);

  const linkToCurrentPane = useCallback(async () => {
    if (!activeResult || !currentPaneEntity || refEquals(activeResult.ref, currentPaneEntity) || linkBusy) return;
    setLinkBusy(true);
    setFeedback({ tone: "neutral", message: "Linking to the current pane…" });
    try {
      const linkResponse = await fetch("/api/entity-references", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          source: currentPaneEntity,
          target: activeResult.ref,
          relation: "related",
        }),
      });
      if (!linkResponse.ok) {
        throw new Error(`REFERENCE_HTTP_${linkResponse.status}`);
      }
      const body = await readJson(linkResponse);
      if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
        throw new Error("INVALID_REFERENCE_RESPONSE");
      }
      window.dispatchEvent(new CustomEvent("axis:entity-references-changed", {
        detail: { source: currentPaneEntity, target: activeResult.ref },
      }));
      const message = `${activeResult.title} linked to the current pane.`;
      setFeedback({ tone: "success", message });
      toast(message, "success", "Workspace");
    } catch (error) {
      const status =
        error instanceof Error && error.message.startsWith("REFERENCE_HTTP_")
          ? Number(error.message.slice("REFERENCE_HTTP_".length))
          : 0;
      if (status === 0 || status >= 500) {
        Sentry.captureException(new Error("Entity reference write failed"), {
          tags: {
            area: "entity_search",
            operation: "reference_write",
            source_kind: currentPaneEntity.kind,
            target_kind: activeResult.ref.kind,
            status: status ? String(status) : "network_or_invalid_response",
          },
        });
      }
      const message = "The related-item link could not be saved. Try again.";
      setFeedback({ tone: "error", message });
      toast(message, "error", "Workspace");
    } finally {
      setLinkBusy(false);
    }
  }, [activeResult, currentPaneEntity, linkBusy, toast]);

  const askAxis = useCallback(async () => {
    if (!trimmedQuery || aiState.status === "loading") return;
    setAiState({ status: "loading" });
    try {
      const aiResponse = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: trimmedQuery }),
      });
      if (!aiResponse.ok) {
        throw new Error(`AI_HTTP_${aiResponse.status}`);
      }
      const body = await readJson(aiResponse);
      if (!isRecord(body) || typeof body.answer !== "string" || body.answer.length > MAX_RESPONSE_TEXT_LENGTH) {
        throw new Error("INVALID_AI_RESPONSE");
      }
      setAiState({ status: "ready", answer: body.answer });
    } catch (error) {
      const status =
        error instanceof Error && error.message.startsWith("AI_HTTP_")
          ? Number(error.message.slice("AI_HTTP_".length))
          : 0;
      if (status === 0 || status >= 500) {
        Sentry.captureException(new Error("Ask Axis search request failed"), {
          tags: {
            area: "entity_search",
            operation: "ask_axis",
            status: status ? String(status) : "network_or_invalid_response",
          },
        });
      }
      const message = "Axis could not answer right now. Your entity results are still available.";
      setAiState({ status: "error", message });
      toast(message, "error", "Ask Axis");
    }
  }, [aiState.status, toast, trimmedQuery]);

  const toggleKind = useCallback((kind: EntityKind) => {
    setSelectedKinds((current) => {
      if (current.has(kind) && current.size === 1) {
        setFeedback({ tone: "error", message: "Keep at least one entity type selected." });
        return current;
      }
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const onComboboxKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) setActiveIndex((index) => Math.min(index < 0 ? 0 : index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) setActiveIndex((index) => Math.max(index < 0 ? results.length - 1 : index - 1, 0));
    } else if (event.key === "Home" && results.length > 0) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && results.length > 0) {
      event.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeResult) void openInWorkspace(activeResult);
      else setFeedback({ tone: "neutral", message: "No entity is selected. Use Ask Axis for an AI answer." });
    }
  }, [activeResult, openInWorkspace, results.length]);

  const unavailableSources = useMemo(
    () => response?.sources.filter((source) => source.status === "unavailable") ?? [],
    [response],
  );
  const currentPaneCanLink = Boolean(
    activeResult && currentPaneEntity && !refEquals(activeResult.ref, currentPaneEntity),
  );

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && handleClose()}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="axis-search-title"
        aria-describedby="axis-search-instructions"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Entity workspace</p>
            <h2 id="axis-search-title" className={styles.title}>Search Axis</h2>
          </div>
          <button type="button" className={styles.iconButton} onClick={handleClose} aria-label="Close search">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <p id="axis-search-instructions" className={styles.srOnly}>
          Type at least two characters. Use Arrow keys, Home, and End to select a result. Press Enter to open it in the workspace. Ask Axis is a separate action.
        </p>

        <div className={styles.searchRow}>
          <span className={styles.searchMark} aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, MAX_QUERY_LENGTH))}
            onKeyDown={onComboboxKeyDown}
            placeholder="Search notes, tasks, people, approvals…"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="axis-entity-search-results"
            aria-activedescendant={activeOptionId}
          />
          <button
            type="button"
            className={styles.askButton}
            onClick={() => void askAxis()}
            disabled={!trimmedQuery || aiState.status === "loading"}
          >
            {aiState.status === "loading" ? <span className={styles.spinner} aria-hidden="true" /> : <span aria-hidden="true">✦</span>}
            {aiState.status === "loading" ? "Asking…" : "Ask Axis"}
          </button>
        </div>

        <div className={styles.filters} role="group" aria-label="Entity type filters">
          <button
            type="button"
            className={`${styles.filter} ${selectedKinds.size === ENTITY_KINDS.length ? styles.filterActive : ""}`}
            aria-pressed={selectedKinds.size === ENTITY_KINDS.length}
            onClick={() => setSelectedKinds(new Set(ENTITY_KINDS))}
          >
            All
          </button>
          {ENTITY_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`${styles.filter} ${selectedKinds.has(kind) ? styles.filterActive : ""}`}
              aria-pressed={selectedKinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              <span aria-hidden="true">{KIND_MARKS[kind]}</span>
              {ENTITY_REGISTRY[kind].pluralLabel}
            </button>
          ))}
        </div>

        {feedback && (
          <div
            className={`${styles.feedback} ${feedback.tone === "error" ? styles.feedbackError : feedback.tone === "success" ? styles.feedbackSuccess : ""}`}
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </div>
        )}

        {response?.partial && (
          <div className={styles.partial} role="status">
            <strong>Partial results.</strong>{" "}
            {unavailableSources.map((source) => source.kind === "usage"
              ? "Personal ranking is unavailable."
              : `${ENTITY_REGISTRY[source.kind].pluralLabel} could not be searched.`).join(" ")}
          </div>
        )}

        {aiState.status === "ready" && (
          <section className={styles.aiAnswer} aria-labelledby="axis-answer-title">
            <div className={styles.sectionHeading}>
              <h3 id="axis-answer-title">✦ Axis answer</h3>
              <button type="button" onClick={() => setAiState({ status: "idle" })}>Dismiss</button>
            </div>
            <p>{aiState.answer}</p>
          </section>
        )}
        {aiState.status === "error" && <div className={styles.aiError} role="alert">{aiState.message}</div>}

        <div className={styles.content}>
          <section className={styles.resultsPane} aria-labelledby="axis-results-title">
            <div className={styles.paneHeading}>
              <h3 id="axis-results-title">Results</h3>
              {searchState === "ready" && <span>{results.length} found</span>}
            </div>

            <div id="axis-entity-search-results" className={styles.results} role="listbox" aria-label="Entity results">
              {trimmedQuery.length < MIN_QUERY_LENGTH && (
                <div className={styles.emptyState} role="status">
                  <span aria-hidden="true">⌕</span>
                  <strong>Find anything in your workspace</strong>
                  <p>Enter at least two characters, then refine by entity type.</p>
                </div>
              )}

              {searchState === "loading" && (
                <div className={styles.emptyState} role="status" aria-live="polite">
                  <span className={styles.largeSpinner} aria-hidden="true" />
                  <strong>Searching your workspace…</strong>
                </div>
              )}

              {searchState === "error" && (
                <div className={styles.emptyState} role="alert">
                  <span aria-hidden="true">!</span>
                  <strong>Search unavailable</strong>
                  <p>{searchError}</p>
                  <button type="button" className={styles.secondaryButton} onClick={() => setSearchRetry((value) => value + 1)}>
                    Try again
                  </button>
                </div>
              )}

              {searchState === "ready" && results.length === 0 && (
                <div className={styles.emptyState} role="status">
                  <span aria-hidden="true">∅</span>
                  <strong>No matching entities</strong>
                  <p>Try a broader phrase or select more entity types.</p>
                </div>
              )}

              {searchState === "ready" && results.map((result, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    key={entityRefKey(result.ref)}
                    id={`axis-search-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-describedby={active ? "axis-entity-preview-status" : undefined}
                    className={`${styles.result} ${active ? styles.resultActive : ""}`}
                    disabled={activationBusy}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => void openInWorkspace(result)}
                  >
                    <span className={styles.kindMark} aria-hidden="true">{KIND_MARKS[result.ref.kind]}</span>
                    <span className={styles.resultCopy}>
                      <span className={styles.resultTitle}>{result.title}</span>
                      <span className={styles.resultMeta}>
                        {ENTITY_REGISTRY[result.ref.kind].label}
                        {result.subtitle ? ` · ${result.subtitle}` : ""}
                      </span>
                    </span>
                    <span className={styles.score} title={result.ranking.reasons.join(" ")}>
                      {Math.round(result.ranking.total)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            className={styles.previewPane}
            aria-labelledby="axis-preview-title"
            aria-live="polite"
            tabIndex={0}
          >
            <div className={styles.paneHeading}>
              <h3 id="axis-preview-title">Preview</h3>
              <span>Read only</span>
            </div>
            <div id="axis-entity-preview-status" className={styles.previewBody}>
              {!activeResult && (
                <div className={styles.previewPlaceholder}>
                  <span aria-hidden="true">◇</span>
                  <p>Select a result to preview it without changing its usage history.</p>
                </div>
              )}
              {activeResult && previewState === "loading" && (
                <div className={styles.previewPlaceholder} role="status">
                  <span className={styles.largeSpinner} aria-hidden="true" />
                  <p>Loading owner-checked preview…</p>
                </div>
              )}
              {activeResult && previewState === "error" && (
                <div className={styles.previewPlaceholder} role="alert">
                  <span aria-hidden="true">!</span>
                  <strong>Preview unavailable</strong>
                  <p>{previewError}</p>
                  <button type="button" className={styles.secondaryButton} onClick={() => setPreviewRetry((value) => value + 1)}>
                    Retry preview
                  </button>
                </div>
              )}
              {activeResult && previewState === "ready" && preview && (
                <>
                  <div className={styles.previewKind}>
                    <span aria-hidden="true">{KIND_MARKS[preview.entity.ref.kind]}</span>
                    {ENTITY_REGISTRY[preview.entity.ref.kind].label}
                    {preview.entity.status && <span className={styles.statusPill}>{preview.entity.status}</span>}
                  </div>
                  <h4 className={styles.previewTitle}>{preview.entity.title}</h4>
                  {preview.entity.subtitle && <p className={styles.previewSubtitle}>{preview.entity.subtitle}</p>}
                  {preview.entity.description && <p className={styles.previewDescription}>{preview.entity.description}</p>}
                  {preview.entity.meta.length > 0 && (
                    <dl className={styles.metaGrid}>
                      {preview.entity.meta.map((item) => (
                        <div key={`${item.label}-${item.value}`}>
                          <dt>{item.label}</dt>
                          <dd>{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <div className={styles.referenceSummary}>
                    <div><strong>{preview.outgoing.length}</strong><span>related</span></div>
                    <div><strong>{preview.backlinks.length}</strong><span>backlinks</span></div>
                  </div>
                  {preview.referencesStatus === "unavailable" && (
                    <p className={styles.referenceWarning} role="status">Related items are temporarily unavailable.</p>
                  )}
                  {(preview.outgoing.length > 0 || preview.backlinks.length > 0) && (
                    <div className={styles.referenceList} aria-label="Related entities">
                      {[...preview.outgoing, ...preview.backlinks].slice(0, 4).map((reference) => (
                        <div key={reference.id}>
                          <span>{reference.direction === "backlink" ? "Linked from" : reference.relation}</span>
                          <strong>{reference.entity.title}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>

        <footer className={styles.footer}>
          <div className={styles.keyboardHint} aria-hidden="true">
            <span>↑↓ choose</span><span>↵ workspace</span><span>esc close</span>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!currentPaneCanLink || linkBusy || activationBusy}
              onClick={() => void linkToCurrentPane()}
              title={!currentPaneEntity ? "Open an entity in a workspace pane first" : undefined}
            >
              {linkBusy ? <span className={styles.spinner} aria-hidden="true" /> : <span aria-hidden="true">∞</span>}
              {linkBusy ? "Linking…" : "Link to current pane"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!activeResult || activationBusy}
              onClick={() => activeResult && void openFullPage(activeResult)}
            >
              <span aria-hidden="true">↗</span>{" "}
              {activeResult && !ENTITY_REGISTRY[activeResult.ref.kind].fullPageSelection
                ? `Open ${ENTITY_REGISTRY[activeResult.ref.kind].pluralLabel}`
                : "Open full page"}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!activeResult || activationBusy}
              onClick={() => activeResult && void openInWorkspace(activeResult)}
            >
              {activationBusy ? <span className={styles.spinner} aria-hidden="true" /> : <span aria-hidden="true">◫</span>}
              {activationBusy ? "Opening…" : "Open in workspace"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
