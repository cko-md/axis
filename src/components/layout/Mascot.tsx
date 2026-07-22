"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "@/components/theme/ThemeProvider";
import { callAiAction } from "@/lib/ai/callAction";
import {
  normalizeAiActionPath,
  sanitizeAiDeckCards,
  type AiDeckCard,
} from "@/lib/ai/navigation";
import {
  aiDegradationLabel,
  type AiResponseMetadata,
} from "@/lib/ai/response";
import { pullSetting, pushSetting } from "@/lib/settings/localMirror";

const FOCUS_SETTING_KEY = "companion.focus";
const isFocusString = (v: unknown): v is string => typeof v === "string";

// ── Module context ─────────────────────────────────────────────────────────────
const MODULE_CONTEXTS: Record<string, string> = {
  "/command":         "Command Center — daily orchestration, tasks, dispatch",
  "/dispatch":        "Dispatch — signal triage and routing",
  "/schedule":        "Schedule — calendar and time blocks",
  "/agenda":          "Agenda — ranked tasks and outreach",
  "/notes":           "Notes — personal knowledge base and writing",
  "/literature":      "Literature — academic papers and research discovery",
  "/vitality":        "Vitality — training, fitness, health metrics",
  "/briefing":        "Briefing — news and media intelligence",
  "/listening-vault": "Listening Vault — music and sound",
  "/fund":            "Fund — portfolio and capital management",
  "/people":          "People — network, contacts, relationships",
  "/pipeline":        "Pipeline — research and project pipeline",
  "/objectives":      "Objectives — OKRs and goal tracking",
  "/atelier":         "Atelier — creative studio",
  "/control-room":    "Control Room — system settings",
};

function buildContext(pathname: string): string {
  const h = new Date().getHours();
  const t = h < 6 ? "early morning" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  const mod = Object.entries(MODULE_CONTEXTS).find(([p]) => pathname.startsWith(p))?.[1] ?? "the home screen";
  return `It's ${t}. Current module: ${mod}.`;
}

function routeFamily(pathname: string): string {
  return Object.keys(MODULE_CONTEXTS).find((path) => pathname.startsWith(path)) ?? "home";
}

function captureCompanionError(
  companion: "axiom" | "codex" | "nova",
  operation: "brief" | "chat" | "cards" | "ask",
  pathname: string,
  status?: number,
) {
  Sentry.captureException(new Error("Companion request failed"), {
    tags: {
      feature: "companion",
      companion,
      operation,
      route: routeFamily(pathname),
      status: status ? String(status) : "unknown",
    },
  });
}

// ── Types ──────────────────────────────────────────────────────────────────────
type Msg = {
  role: "user" | "assistant";
  content: string;
  meta?: AiResponseMetadata;
};
type Card = AiDeckCard;

function AiDegradedNote({ meta }: { meta: AiResponseMetadata | null | undefined }) {
  if (!meta?.degraded) return null;
  return (
    <div className="cp-privacy" role="status">
      <span />
      {aiDegradationLabel(meta.reason)}
    </div>
  );
}

// ── SVG characters ─────────────────────────────────────────────────────────────

function MonolithSVG({ size = 52 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 84 100" width={size} height={size * 1.2} aria-hidden>
      <defs>
        <linearGradient id={`mBody${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(40,44,52,.92)" />
          <stop offset="100%" stopColor="rgba(14,16,20,.96)" />
        </linearGradient>
        <radialGradient id={`mCore${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold-2)" />
          <stop offset="55%" stopColor="var(--gold)" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`mHalo${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="m-shadow" cx="42" cy="95" rx="17" ry="3.2" fill="rgba(0,0,0,.34)" />
      <g className="mono-ring mr1">
        <ellipse cx="42" cy="50" rx="23" ry="5.5" fill="none" stroke="var(--gold)" strokeWidth="0.6" opacity="0.28" />
        <circle cx="65" cy="50" r="1.5" fill="var(--gold-2)" className="mono-re me1" />
      </g>
      <g className="mono-ring mr2" transform="rotate(72, 42, 50)">
        <ellipse cx="42" cy="50" rx="20" ry="5" fill="none" stroke="var(--gold)" strokeWidth="0.5" opacity="0.18" />
        <circle cx="62" cy="50" r="1.1" fill="var(--gold)" className="mono-re me2" />
      </g>
      <g className="m-body">
        <path d="M42 8 L57 22 L55 90 L29 90 L27 22 Z" fill={`url(#mBody${uid})`} stroke="var(--line-strong)" strokeWidth="1" />
        <path d="M27 22 L42 8 L42 90 L29 90 Z" fill="rgba(255,255,255,.042)" />
        <path d="M42 8 L57 22 L42 27 L27 22 Z" fill="none" stroke="var(--gold)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M42 8 L42 27" stroke="var(--gold)" strokeWidth=".8" opacity=".55" />
        <line x1="42" y1="30" x2="42" y2="86" stroke="var(--gold)" strokeWidth="1" opacity=".22" />
        <line x1="30" y1="42" x2="54" y2="42" stroke="var(--gold)" strokeWidth="0.5" opacity="0.1" />
        <line x1="30" y1="62" x2="54" y2="62" stroke="var(--gold)" strokeWidth="0.5" opacity="0.07" />
        <circle className="mono-core" cx="42" cy="50" r="7" fill={`url(#mCore${uid})`} />
        <circle cx="42" cy="50" r="2.4" fill="var(--gold-2)" />
        <line x1="34" y1="68" x2="50" y2="68" stroke="var(--ink-faint)" strokeWidth="1" opacity=".6" />
        <line x1="34" y1="74" x2="46" y2="74" stroke="var(--ink-faint)" strokeWidth="1" opacity=".4" />
      </g>
      <ellipse cx="42" cy="89" rx="18" ry="5" fill={`url(#mHalo${uid})`} />
    </svg>
  );
}

// Data terminal — original Codex character form
function CodexSVG({ size = 52 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 84 100" width={size} height={size * 1.2} aria-hidden>
      <defs>
        <linearGradient id={`dkBody${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(40,44,52,.92)" />
          <stop offset="100%" stopColor="rgba(16,18,23,.96)" />
        </linearGradient>
      </defs>
      <ellipse className="m-shadow" cx="42" cy="92" rx="20" ry="3.4" fill="rgba(0,0,0,.32)" />
      <g className="m-body">
        <rect x="10" y="34" width="64" height="50" rx="7" fill={`url(#dkBody${uid})`} stroke="var(--line-strong)" strokeWidth="1" />
        <line x1="18" y1="34" x2="66" y2="34" stroke="var(--edge)" strokeWidth="1" opacity=".5" />
        <circle cx="64" cy="42" r="2" fill="var(--gold)" />
        <circle cx="64" cy="42" r="3.4" fill="none" stroke="var(--gold)" strokeWidth=".8" opacity=".4" />
        <rect x="18" y="46" width="48" height="22" rx="3" fill="rgba(8,10,14,.7)" stroke="var(--line)" strokeWidth="1" />
        <polyline className="deck-scope" points="20,57 26,57 30,50 34,64 38,52 42,60 46,55 52,57 64,57" fill="none" stroke="var(--gold)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <g className="deck-eq" transform="translate(34,73)">
          <rect className="eqb e1" x="0" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
          <rect className="eqb e2" x="5" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
          <rect className="eqb e3" x="10" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
        </g>
      </g>
    </svg>
  );
}

function NovaSVG({ size = 52 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 84 100" width={size} height={size * 1.2} aria-hidden>
      <defs>
        <radialGradient id={`nvCore${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="white" />
          <stop offset="22%" stopColor="var(--companion-nova-glow)" />
          <stop offset="55%" stopColor="var(--companion-nova-core)" />
          <stop offset="100%" stopColor="var(--companion-nova-core)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`nvAura${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--companion-nova-core)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--companion-nova-core)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ambient shadow */}
      <ellipse className="nova-shad" cx="42" cy="95" rx="16" ry="3" fill="color-mix(in srgb, var(--companion-nova-core) 18%, transparent)" />

      {/* Soft round star-dots scattered in field */}
      <circle className="nova-star ns1" cx="8"  cy="14" r="1.3" fill="var(--companion-nova-glow)" />
      <circle className="nova-star ns2" cx="70" cy="8"  r="1.0" fill="white" />
      <circle className="nova-star ns3" cx="78" cy="38" r="1.1" fill="var(--companion-nova-glow)" />
      <circle className="nova-star ns4" cx="70" cy="74" r="0.9" fill="var(--gold)" />
      <circle className="nova-star ns5" cx="18" cy="83" r="1.2" fill="var(--companion-nova-glow)" />
      <circle className="nova-star ns6" cx="4"  cy="55" r="1.0" fill="white" />
      <circle className="nova-star ns7" cx="48" cy="3"  r="0.9" fill="var(--companion-nova-glow)" />
      <circle className="nova-star ns8" cx="62" cy="84" r="0.8" fill="white" />

      {/* Atmospheric aura */}
      <circle className="nova-aura" cx="42" cy="48" r="34" fill={`url(#nvAura${uid})`} />

      {/* Atomic orbital rings — each pre-tilted at a different inclination */}
      {/* nr1: equatorial plane */}
      <g className="nova-ring nr1">
        <ellipse cx="42" cy="48" rx="27" ry="6" fill="none" stroke="var(--companion-nova-core)" strokeWidth="0.9" opacity="0.62" />
        <circle cx="69" cy="48" r="2.4" fill="white" className="nova-e ne1" />
      </g>
      {/* nr2: tilted 58° */}
      <g className="nova-ring nr2" transform="rotate(58, 42, 48)">
        <ellipse cx="42" cy="48" rx="24" ry="5.5" fill="none" stroke="var(--companion-nova-glow)" strokeWidth="0.8" opacity="0.48" />
        <circle cx="66" cy="48" r="2.0" fill="var(--companion-nova-glow)" className="nova-e ne2" />
      </g>
      {/* nr3: tilted 112° */}
      <g className="nova-ring nr3" transform="rotate(112, 42, 48)">
        <ellipse cx="42" cy="48" rx="21" ry="5" fill="none" stroke="color-mix(in srgb, var(--companion-axiom-ring) 60%, transparent)" strokeWidth="0.8" opacity="0.48" />
        <circle cx="63" cy="48" r="1.8" fill="var(--gold)" className="nova-e ne3" />
      </g>
      {/* nr4: tilted −38° */}
      <g className="nova-ring nr4" transform="rotate(-38, 42, 48)">
        <ellipse cx="42" cy="48" rx="25" ry="5" fill="none" stroke="var(--companion-nova-glow)" strokeWidth="0.7" opacity="0.32" />
        <circle cx="67" cy="48" r="1.5" fill="var(--companion-nova-glow)" className="nova-e ne4" />
      </g>
      {/* nr5: tilted 82° (near-vertical — completes the field) */}
      <g className="nova-ring nr5" transform="rotate(82, 42, 48)">
        <ellipse cx="42" cy="48" rx="20" ry="5" fill="none" stroke="var(--companion-nova-core)" strokeWidth="0.6" opacity="0.26" />
        <circle cx="62" cy="48" r="1.3" fill="white" className="nova-e ne5" />
      </g>

      {/* Core glow layers */}
      <circle cx="42" cy="48" r="12" fill="var(--companion-nova-core)" opacity="0.14" className="nova-gl g2" />
      <circle cx="42" cy="48" r="7.5" fill="var(--companion-nova-core)" opacity="0.6" className="nova-gl g1" />
      <circle cx="42" cy="48" r="5.5" fill={`url(#nvCore${uid})`} className="nova-core" />
      <circle cx="42" cy="48" r="2.2" fill="white" opacity="0.96" />
    </svg>
  );
}

// ── Popout speech-bubble shell ─────────────────────────────────────────────────
function PopoutShell({ children, className, onClose, title, sub, icon, controls }: {
  children: React.ReactNode;
  className?: string;
  onClose:   () => void;
  title:     string;
  sub:       string;
  icon:      React.ReactNode;
  controls?: React.ReactNode;
}) {
  const titleId = useId();
  const popoutRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !popoutRef.current) return;
      const focusable = Array.from(
        popoutRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, []);

  return (
    <div
      className={`cp-popout${className ? " " + className : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={popoutRef}
    >
      <div className="cp-head">
        <div className="cp-ident">
          {icon}
          <span id={titleId}>{title}</span>
          <span className="cp-sub">{sub}</span>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {controls}
          <button type="button" className="cp-x" onClick={onClose} aria-label={`Close ${title}`} ref={closeRef}>✕</button>
        </div>
      </div>
      {children}
    </div>
  );
}

function CompanionPrivacyNote({ mode }: { mode: "chat" | "cards" | "oracle" }) {
  const label = mode === "cards"
    ? "Module context is sent for cards"
    : mode === "oracle"
      ? "Question sent to AXIS AI"
      : "Prompt and recent thread sent to AXIS AI";
  return (
    <div className="cp-privacy">
      <span />
      {label}
    </div>
  );
}

// ── Axiom — strategic advisor with persistent focus tracking ──────────────────
function AxiomChar({ onHide }: { onHide: () => void }) {
  const pathname = usePathname();
  const context  = useMemo(() => buildContext(pathname), [pathname]);
  const [open, setOpen]               = useState(false);
  const [messages, setMessages]       = useState<Msg[]>([]);
  const [input, setInput]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [focus, setFocus]             = useState("");
  const [editingFocus, setEditingFocus] = useState(false);
  const briefedRef    = useRef(false);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLInputElement>(null);
  const focusInputRef = useRef<HTMLInputElement>(null);
  const briefAbortRef = useRef<AbortController | null>(null);
  const sendAbortRef  = useRef<AbortController | null>(null);

  useEffect(() => {
    const local = localStorage.getItem("axiom-focus") ?? "";
    setFocus(local);
    void (async () => {
      const remote = await pullSetting(FOCUS_SETTING_KEY, isFocusString);
      if (remote !== null) {
        setFocus(remote);
        localStorage.setItem("axiom-focus", remote);
      } else if (local) {
        pushSetting(FOCUS_SETTING_KEY, local);
      }
    })();
  }, []);

  // Abort any in-flight requests on unmount.
  useEffect(() => {
    return () => {
      briefAbortRef.current?.abort();
      sendAbortRef.current?.abort();
    };
  }, []);

  const saveFocus = (v: string) => {
    setFocus(v);
    localStorage.setItem("axiom-focus", v);
    pushSetting(FOCUS_SETTING_KEY, v);
  };

  const generateBrief = useCallback(async () => {
    briefAbortRef.current?.abort();
    const controller = new AbortController();
    briefAbortRef.current = controller;
    setLoading(true);
    try {
      const result = await callAiAction("companion", {
        text: `Deliver a 2-sentence strategic situation brief. ${context}. ${focus ? `User's active focus: "${focus}".` : "No active focus set — prompt them to set one."} Be direct. Field advisor tone, not chatbot. Surface one actionable priority.`,
        body: JSON.stringify({ context, history: [], persona: "axiom" }),
      }, { signal: controller.signal });
      if (!result.ok) {
        if (result.error === "aborted") return;
        captureCompanionError("axiom", "brief", pathname);
        setMessages([{ role: "assistant", content: "Briefing service is unavailable. Try again shortly." }]);
        return;
      }
      setMessages([{
        role: "assistant",
        content: result.data.response || "Situation nominal. Set a focus for a targeted brief.",
        meta: result.data.meta,
      }]);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      captureCompanionError("axiom", "brief", pathname);
      setMessages([{ role: "assistant", content: "Offline. Reconnect to receive briefing." }]);
    } finally {
      if (briefAbortRef.current === controller) setLoading(false);
    }
  }, [context, focus, pathname]);

  useEffect(() => {
    if (open && !briefedRef.current) {
      briefedRef.current = true;
      void generateBrief();
    }
    if (!open) briefedRef.current = false;
  }, [open, generateBrief]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    sendAbortRef.current?.abort();
    const controller = new AbortController();
    sendAbortRef.current = controller;
    setInput("");
    setMessages((p) => [...p, { role: "user", content: q }]);
    setLoading(true);
    try {
      const result = await callAiAction("companion", {
        text: q,
        body: JSON.stringify({
          context,
          history: messages.slice(-8).map(({ role, content }) => ({ role, content })),
          persona: "axiom",
        }),
      }, { signal: controller.signal });
      if (!result.ok) {
        if (result.error === "aborted") return;
        captureCompanionError("axiom", "chat", pathname);
        setMessages((p) => [...p, { role: "assistant", content: "Connection reached AXIS, but the companion service returned an error." }]);
        return;
      }
      setMessages((p) => [...p, {
        role: "assistant",
        content: result.data.response || "…",
        meta: result.data.meta,
      }]);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      captureCompanionError("axiom", "chat", pathname);
      setMessages((p) => [...p, { role: "assistant", content: "Connection lost." }]);
    } finally {
      if (sendAbortRef.current === controller) {
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }
  }, [input, loading, context, messages, pathname]);

  return (
    <div className="cp-char">
      <button type="button" className="cp-dismiss" onClick={onHide} title="Dismiss Axiom" aria-label="Dismiss Axiom">✕</button>
      <div
        className={`cp-fig cp-fig-mono${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((o) => !o); }}
        aria-label="Toggle Axiom"
        aria-expanded={open}
      >
        <MonolithSVG size={52} />
      </div>

      {open && (
        <PopoutShell
          className="cp-popout-axiom"
          title="AXIOM"
          sub="Field Ops"
          icon={<MonolithSVG size={18} />}
          onClose={() => setOpen(false)}
        >
          {/* Persistent focus track — survives sessions */}
          <div className="ax-focus">
            <div className="ax-focus-label">ACTIVE FOCUS <span>LOCAL ONLY</span></div>
            {editingFocus ? (
              <input
                ref={focusInputRef}
                className="ax-focus-input"
                value={focus}
                onChange={(e) => saveFocus(e.target.value)}
                onBlur={() => setEditingFocus(false)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingFocus(false); }}
                placeholder="Set current objective…"
                autoFocus
              />
            ) : (
              <button type="button" className="ax-focus-val" onClick={() => setEditingFocus(true)}>
                <span>{focus || "— Set objective —"}</span>
                <span className="ax-focus-edit">✎</span>
              </button>
            )}
          </div>
          <CompanionPrivacyNote mode="chat" />

          <div className="cp-msgs">
            {loading && messages.length === 0 ? (
              <div className="ax-brief-loading">
                <span className="cp-dots"><span /><span /><span /></span>
                <span className="ax-brief-label">Generating brief…</span>
              </div>
            ) : messages.map((m, i) => (
              <div key={i} className={`cp-msg ${m.role === "user" ? "cp-you" : "cp-ai"}`}>
                <span>
                  {m.content}
                  {m.role === "assistant" && m.meta?.degraded ? (
                    <small style={{ display: "block", marginTop: 7, fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" }}>
                      {aiDegradationLabel(m.meta.reason)}
                    </small>
                  ) : null}
                </span>
              </div>
            ))}
            {loading && messages.length > 0 && (
              <div className="cp-msg cp-ai cp-typing">
                <span className="cp-dots"><span /><span /><span /></span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="cp-input-bar">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Brief Axiom…"
              className="cp-input"
              disabled={loading}
            />
            <button type="button" onClick={() => void send()} className="cp-send" disabled={loading || !input.trim()} aria-label="Send to Axiom">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" /></svg>
            </button>
          </div>
        </PopoutShell>
      )}
    </div>
  );
}

// ── Codex — contextual intelligence cards ──────────────────────────────────────
function CodexChar({ onHide }: { onHide: () => void }) {
  const pathname = usePathname();
  const router   = useRouter();
  const context  = useMemo(() => buildContext(pathname), [pathname]);
  const [open, setOpen]           = useState(false);
  const [cards, setCards]         = useState<Card[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [loading, setLoading]     = useState(false);
  const [responseMeta, setResponseMeta] = useState<AiResponseMetadata | null>(null);

  const loadCards = useCallback(async () => {
    setLoading(true);
    setDismissed(new Set());
    try {
      const result = await callAiAction("deckInsights", {
        text: context,
        body: JSON.stringify({ context }),
      });
      if (!result.ok) {
        captureCompanionError("codex", "cards", pathname);
        setResponseMeta(null);
        setCards([{ id: "e", title: "Unavailable", body: "Context cards are unavailable right now. Try refresh shortly." }]);
        return;
      }
      setResponseMeta(result.data.meta);
      setCards(sanitizeAiDeckCards(result.data.cards));
    } catch {
      captureCompanionError("codex", "cards", pathname);
      setResponseMeta(null);
      setCards([{ id: "e", title: "Offline", body: "Couldn't reach the AI. Check your connection." }]);
    } finally {
      setLoading(false);
    }
  }, [context, pathname]);

  const navigateToCardAction = useCallback((actionPath: string) => {
    const safePath = normalizeAiActionPath(actionPath);
    if (safePath) router.push(safePath);
  }, [router]);

  useEffect(() => {
    if (open && cards.length === 0) void loadCards();
  }, [open, loadCards, cards.length]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);

  const visible = cards.filter((c) => !dismissed.has(c.id));

  return (
    <div className="cp-char">
      <button type="button" className="cp-dismiss" onClick={onHide} title="Dismiss Codex" aria-label="Dismiss Codex">✕</button>
      <div
        className={`cp-fig cp-fig-cdx${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((o) => !o); }}
        aria-label="Toggle Codex"
        aria-expanded={open}
      >
        <CodexSVG size={52} />
      </div>

      {open && (
        <PopoutShell
          className="cp-popout-codex"
          title="CODEX"
          sub="Contextual Intel"
          icon={<CodexSVG size={18} />}
          onClose={() => setOpen(false)}
          controls={
            <button type="button" onClick={() => void loadCards()} className="cp-refresh" disabled={loading} title="Refresh" aria-label="Refresh Codex cards">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 12, height: 12 }}>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4" />
              </svg>
            </button>
          }
        >
          <div className="cp-context-tag">{context.split(". ").pop()}</div>
          <CompanionPrivacyNote mode="cards" />
          <AiDegradedNote meta={responseMeta} />
          <div className="cp-cards">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="cp-card cp-skel" />)
            ) : visible.length === 0 ? (
              <div className="cp-empty">All clear — no signals right now.</div>
            ) : (
              visible.map((card) => (
                <div key={card.id} className="cp-card">
                  <button type="button" className="cp-card-x" onClick={() => setDismissed((p) => new Set([...p, card.id]))} aria-label={`Dismiss ${card.title}`}>✕</button>
                  <div className="cp-card-title">{card.title}</div>
                  <div className="cp-card-body">{card.body}</div>
                  {card.actionLabel && card.actionPath && (
                    <button type="button" className="cp-card-act" onClick={() => navigateToCardAction(card.actionPath!)}>
                      {card.actionLabel} →
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </PopoutShell>
      )}
    </div>
  );
}

// ── Nova — quick oracle ────────────────────────────────────────────────────────
function NovaChar({ onHide }: { onHide: () => void }) {
  const pathname = usePathname();
  const context  = useMemo(() => buildContext(pathname), [pathname]);
  const [open, setOpen]         = useState(false);
  const [query, setQuery]       = useState("");
  const [response, setResponse] = useState<{ content: string; meta?: AiResponseMetadata } | null>(null);
  const [loading, setLoading]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setResponse(null); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);

  const ask = useCallback(async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setResponse(null);
    try {
      const result = await callAiAction("companion", {
        text: q,
        body: JSON.stringify({ context, history: [], persona: "nova" }),
      });
      if (!result.ok) {
        captureCompanionError("nova", "ask", pathname);
        setResponse({ content: "Nova is unavailable right now. Try again shortly." });
        return;
      }
      setResponse({
        content: result.data.response || "…",
        meta: result.data.meta,
      });
      setQuery("");
    } catch {
      captureCompanionError("nova", "ask", pathname);
      setResponse({ content: "Connection lost — try again." });
    } finally {
      setLoading(false);
    }
  }, [query, loading, context, pathname]);

  return (
    <div className="cp-char">
      <button type="button" className="cp-dismiss" onClick={onHide} title="Dismiss Nova" aria-label="Dismiss Nova">✕</button>
      <div
        className={`cp-fig cp-fig-nova${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((o) => !o); }}
        aria-label="Toggle Nova"
        aria-expanded={open}
      >
        <NovaSVG size={52} />
      </div>

      {open && (
        <PopoutShell
          className="cp-popout-nova"
          title="NOVA"
          sub="Quick Oracle"
          icon={<NovaSVG size={18} />}
          onClose={() => { setOpen(false); setResponse(null); }}
        >
          <CompanionPrivacyNote mode="oracle" />
          <AiDegradedNote meta={response?.meta} />
          {response && <div className="cp-nova-resp">{response.content}</div>}
          <div className="cp-input-bar" style={response ? { borderTop: "1px solid var(--line)" } : undefined}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void ask(); } }}
              placeholder={loading ? "Thinking…" : "Ask anything…"}
              className="cp-input"
              disabled={loading}
            />
            <button type="button" onClick={() => void ask()} className="cp-send" disabled={loading || !query.trim()} aria-label="Send to Nova">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" /></svg>
            </button>
          </div>
        </PopoutShell>
      )}
    </div>
  );
}

// ── Restore button ─────────────────────────────────────────────────────────────
function RestoreButton({ name, onRestore }: { name: string; onRestore: () => void }) {
  return (
    <button type="button" className="mascot-restore on" title={`Summon ${name}`} aria-label={`Summon ${name}`} onClick={onRestore}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 3 L19 9 L17 21 L7 21 L5 9 Z" /><circle cx="12" cy="13" r="2.4" />
      </svg>
    </button>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────
export function Mascot() {
  const { interfaceSettings, setInterfaceSettings } = useTheme();
  const [hidden, setHidden] = useState(false);

  const hide = useCallback(() => {
    setHidden(true);
    setInterfaceSettings((s) => ({ ...s, presence: "hide" }));
  }, [setInterfaceSettings]);

  const restore = useCallback(() => {
    setHidden(false);
    setInterfaceSettings((s) => ({ ...s, presence: "show" }));
  }, [setInterfaceSettings]);

  const companion     = interfaceSettings.companion;
  const restoreName   = companion === "nova" ? "Nova" : companion === "deck" ? "Codex" : "Axiom";

  if (interfaceSettings.presence === "hide" || hidden) {
    return <RestoreButton name={restoreName} onRestore={restore} />;
  }

  if (companion === "monolith") return <AxiomChar onHide={hide} />;
  if (companion === "deck")     return <CodexChar onHide={hide} />;
  return <NovaChar onHide={hide} />;
}
