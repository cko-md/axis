"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ACCENT_PRESETS } from "@/lib/theme/interface-settings";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import styles from "./ControlRoom.module.css";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "connections", label: "Connections" },
  { id: "data", label: "Data & Privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type ConnState = "on" | "off" | "pending";

type ServiceStatus = {
  configured: boolean;
  message: string;
};

type UserInfo = {
  email: string;
  id: string;
  createdAt: string | null;
  lastSignIn: string | null;
  displayName: string | null;
  roleTitle: string | null;
};

type ActivityItem = {
  kind: string;
  text: string;
  at: string;
};

const THEME_LABEL: Record<string, string> = {
  dark: "Dark",
  dim: "Dim",
  slate: "Slate",
  light: "Light",
};

const FACE_LABEL: Record<string, string> = {
  instrument: "Instrument Serif",
  playfair: "Playfair Display",
  grotesk: "Space Grotesk",
  archivo: "Archivo",
  inter: "Inter",
  plex: "IBM Plex Sans",
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ControlRoomModule() {
  const [tab, setTab] = useState<TabId>("overview");
  const { theme, interfaceSettings, openInterfaceStudio } = useTheme();
  const { toast } = useToast();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Auth / connection state ------------------------------------------------
  const [user, setUser] = useState<UserInfo | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Service setup-states ---------------------------------------------------
  const [marketStatus, setMarketStatus] = useState<ServiceStatus | null>(null);
  const [aiStatus, setAiStatus] = useState<ServiceStatus | null>(null);
  const [spotifyConnected, setSpotifyConnected] = useState<boolean | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<ServiceStatus | null>(null);
  const [plaidStatus, setPlaidStatus] = useState<ServiceStatus | null>(null);

  // Activity ---------------------------------------------------------------
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [counts, setCounts] = useState<{ notes: number; signals: number; tasks: number; events: number } | null>(null);

  // Modals -----------------------------------------------------------------
  const [clearOpen, setClearOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  // Count of axis-* keys cached in this browser (recomputed when the tab changes).
  const [localItemCount, setLocalItemCount] = useState(0);

  // --- Load auth + Supabase-backed status ---------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (!alive) return;
      if (error || !data.user) {
        setAuthError("Not signed in.");
        setAuthLoading(false);
        return;
      }
      const u = data.user;
      let displayName: string | null = null;
      let roleTitle: string | null = null;
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, role_title")
        .eq("id", u.id)
        .maybeSingle();
      if (profile) {
        displayName = profile.display_name ?? null;
        roleTitle = profile.role_title ?? null;
      }
      if (!alive) return;
      setUser({
        email: u.email ?? "—",
        id: u.id,
        createdAt: u.created_at ?? null,
        lastSignIn: u.last_sign_in_at ?? null,
        displayName,
        roleTitle,
      });
      setAuthLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [supabase]);

  // --- Load env-driven service setup-states -------------------------------
  useEffect(() => {
    let alive = true;
    const grab = async (url: string): Promise<ServiceStatus | null> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return { configured: false, message: "Status unavailable." };
        const json = await res.json();
        return { configured: !!json.configured, message: json.message ?? "" };
      } catch {
        return { configured: false, message: "Status unavailable." };
      }
    };
    (async () => {
      const [m, ai, b, p] = await Promise.all([
        grab("/api/massive/status"),
        grab("/api/ai/status"),
        grab("/api/brokerage/status"),
        grab("/api/plaid/status"),
      ]);
      if (!alive) return;
      setMarketStatus(m);
      setAiStatus(ai);
      setBrokerStatus(b);
      setPlaidStatus(p);
      try {
        const sp = await fetch("/api/spotify/playback", { cache: "no-store" });
        const spJson = await sp.json();
        if (alive) setSpotifyConnected(!!spJson.connected);
      } catch {
        if (alive) setSpotifyConnected(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // --- Load real activity from content tables -----------------------------
  const loadActivity = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setActivity([]);
      setCounts({ notes: 0, signals: 0, tasks: 0, events: 0 });
      return;
    }
    const uid = auth.user.id;
    const items: ActivityItem[] = [];

    const [notes, signals, tasks, events] = await Promise.all([
      supabase.from("notes").select("title, updated_at", { count: "exact" }).eq("user_id", uid).order("updated_at", { ascending: false }).limit(5),
      supabase.from("signals").select("title, created_at", { count: "exact" }).eq("user_id", uid).order("created_at", { ascending: false }).limit(5),
      supabase.from("tasks").select("title, updated_at", { count: "exact" }).eq("user_id", uid).order("updated_at", { ascending: false }).limit(5),
      supabase.from("schedule_events").select("title, updated_at", { count: "exact" }).eq("user_id", uid).order("updated_at", { ascending: false }).limit(5),
    ]);

    (notes.data ?? []).forEach((n) => items.push({ kind: "Note", text: n.title || "Untitled", at: n.updated_at }));
    (signals.data ?? []).forEach((s) => items.push({ kind: "Signal", text: s.title || "Signal", at: s.created_at }));
    (tasks.data ?? []).forEach((t) => items.push({ kind: "Task", text: t.title || "Task", at: t.updated_at }));
    (events.data ?? []).forEach((e) => items.push({ kind: "Event", text: e.title || "Event", at: e.updated_at }));

    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    setActivity(items.slice(0, 14));
    setCounts({
      notes: notes.count ?? 0,
      signals: signals.count ?? 0,
      tasks: tasks.count ?? 0,
      events: events.count ?? 0,
    });
  }, [supabase]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  // --- Actions ------------------------------------------------------------
  const connectSpotify = () => {
    // OAuth redirect lives at /api/spotify/auth; it 503s cleanly if unconfigured.
    window.location.href = "/api/spotify/auth";
  };

  const exportLocalData = () => {
    try {
      const payload: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("axis-")) continue;
        const raw = localStorage.getItem(key);
        try {
          payload[key] = raw ? JSON.parse(raw) : raw;
        } catch {
          payload[key] = raw;
        }
      }
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: payload }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `axis-local-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Local data exported", "success", "Data & Privacy");
    } catch {
      toast("Export failed", "error", "Data & Privacy");
    }
  };

  const clearLocalData = () => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("axis-")) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    setClearOpen(false);
    toast(`Cleared ${keys.length} local item${keys.length === 1 ? "" : "s"}. Reloading…`, "success", "Data & Privacy");
    setTimeout(() => window.location.reload(), 700);
  };

  const doSignOut = async () => {
    setSignOutOpen(false);
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  // --- Derived ------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("axis-")) n++;
    }
    setLocalItemCount(n);
  }, [tab]);

  const accentLabel = ACCENT_PRESETS[interfaceSettings.accent]?.label ?? interfaceSettings.accent;

  // --- Service definitions for the Connections tab ------------------------
  const connections: {
    name: string;
    desc: string;
    state: ConnState;
    detail: string;
    action?: { label: string; onClick: () => void };
  }[] = [
    {
      name: "Supabase",
      desc: "Auth, Postgres & sync — Notes, Signals, Fund, Schedule",
      state: user ? "on" : authLoading ? "pending" : "off",
      detail: user ? "Signed in, RLS enforced" : "Not signed in",
    },
    {
      name: "Market Data",
      desc: "Fund quotes & snapshots (Polygon / Massive)",
      state: marketStatus ? (marketStatus.configured ? "on" : "off") : "pending",
      detail: marketStatus?.message ?? "Checking…",
    },
    {
      name: "Spotify",
      desc: "Listening Vault & sidebar miniplayer",
      state: spotifyConnected === null ? "pending" : spotifyConnected ? "on" : "off",
      detail:
        spotifyConnected === null
          ? "Checking…"
          : spotifyConnected
            ? "Connected via OAuth"
            : "Connect your Spotify account",
      action:
        spotifyConnected === false
          ? { label: "Connect", onClick: connectSpotify }
          : undefined,
    },
    {
      name: "AI (Anthropic)",
      desc: "Capture classification & signal triage",
      state: aiStatus ? (aiStatus.configured ? "on" : "off") : "pending",
      detail: aiStatus ? (aiStatus.configured ? "Model-backed" : "Heuristic fallback (no key)") : "Checking…",
    },
    {
      name: "Brokerage (Public.com)",
      desc: "Fund order routing",
      state: brokerStatus ? (brokerStatus.configured ? "on" : "off") : "pending",
      detail: brokerStatus ? (brokerStatus.configured ? "Configured" : "Orders logged locally") : "Checking…",
    },
    {
      name: "Banking (Plaid)",
      desc: "Account balances & links",
      state: plaidStatus ? (plaidStatus.configured ? "on" : "off") : "pending",
      detail: plaidStatus ? (plaidStatus.configured ? "Configured" : "Not configured") : "Checking…",
    },
  ];

  const connectedCount = connections.filter((c) => c.state === "on").length;

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">System</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Control Room</h1>
      <p className="sub">The console&apos;s machinery — account, connections, data, and appearance.</p>

      <div className="subtabbar" style={{ marginTop: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "subtab on" : "subtab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------------------- OVERVIEW */}
      <div className={tab === "overview" ? "subpanel on" : "subpanel"}>
        <div className={styles.grid2}>
          <div className="card tick">
            <h2 className="sec">
              Session<span className="rule" />
            </h2>
            {authLoading ? (
              <p className={styles.note}>Checking session…</p>
            ) : authError ? (
              <div className="empty-state">
                <div>Not signed in</div>
                <p>Sign in to surface your account and live connection status.</p>
              </div>
            ) : user ? (
              <>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Account</span>
                  <span className={styles.kvVal}>{user.email}</span>
                </div>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Auth</span>
                  <span className={styles.kvVal} style={{ color: "var(--up)" }}>
                    Supabase · RLS active
                  </span>
                </div>
                {user.lastSignIn && (
                  <div className={styles.kv}>
                    <span className={styles.kvKey}>Last sign-in</span>
                    <span className={styles.kvVal}>{relTime(user.lastSignIn)}</span>
                  </div>
                )}
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Connections live</span>
                  <span className={styles.kvVal}>
                    {connectedCount} / {connections.length}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <div className="card">
            <h2 className="sec">
              Services<span className="rule" />
            </h2>
            {connections.slice(1).map((c) => (
              <div key={c.name} className={styles.svcRow}>
                <span className={styles.svcDot} data-state={c.state} />
                <div className={styles.svcBody}>
                  <div className={styles.svcName}>{c.name}</div>
                  <div className={styles.svcDesc}>{c.detail}</div>
                </div>
                <span className={styles.svcState} data-state={c.state}>
                  {c.state === "on" ? "Live" : c.state === "pending" ? "…" : "Setup"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="sec">
            Your Data<span className="rule" />
          </h2>
          {counts ? (
            <div className="stat-strip" style={{ marginTop: 6 }}>
              <div className="stat">
                <div className="sv">{counts.notes}</div>
                <div className="sk">Notes</div>
              </div>
              <div className="stat">
                <div className="sv">{counts.signals}</div>
                <div className="sk">Signals</div>
              </div>
              <div className="stat">
                <div className="sv">{counts.tasks}</div>
                <div className="sk">Tasks</div>
              </div>
              <div className="stat">
                <div className="sv">{counts.events}</div>
                <div className="sk">Events</div>
              </div>
            </div>
          ) : (
            <p className={styles.note}>Loading counts…</p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------- CONNECTIONS */}
      <div className={tab === "connections" ? "subpanel on" : "subpanel"}>
        <div className="card">
          <h2 className="sec">
            Integrations<span className="rule" />
          </h2>
          <p className={styles.note} style={{ marginBottom: 4 }}>
            Live status is read from the server — credentials never leave it. Services without keys show a setup state
            rather than fake data.
          </p>
          {connections.map((c) => (
            <div key={c.name} className={styles.svcRow}>
              <span className={styles.svcDot} data-state={c.state} />
              <div className={styles.svcBody}>
                <div className={styles.svcName}>{c.name}</div>
                <div className={styles.svcDesc}>
                  {c.desc} — {c.detail}
                </div>
              </div>
              {c.action ? (
                <button type="button" className={styles.svcAction} onClick={c.action.onClick}>
                  {c.action.label}
                </button>
              ) : (
                <span className={styles.svcState} data-state={c.state}>
                  {c.state === "on" ? "Connected" : c.state === "pending" ? "Checking" : "Not set"}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ----------------------------------------------------------- DATA & PRIVACY */}
      <div className={tab === "data" ? "subpanel on" : "subpanel"}>
        <div className={styles.grid2}>
          <div className="card tick">
            <h2 className="sec">
              Account<span className="rule" />
            </h2>
            {user ? (
              <>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Name</span>
                  <span className={styles.kvVal}>{user.displayName || "—"}</span>
                </div>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Role</span>
                  <span className={styles.kvVal}>{user.roleTitle || "—"}</span>
                </div>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Email</span>
                  <span className={styles.kvVal}>{user.email}</span>
                </div>
                {user.createdAt && (
                  <div className={styles.kv}>
                    <span className={styles.kvKey}>Member since</span>
                    <span className={styles.kvVal}>
                      {new Date(user.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  className={styles.dangerBtn}
                  style={{ marginTop: 14 }}
                  onClick={() => setSignOutOpen(true)}
                >
                  Sign out
                </button>
              </>
            ) : (
              <div className="empty-state">
                <div>Not signed in</div>
                <p>Sign in to manage your account.</p>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="sec">
              Local Data<span className="rule" />
            </h2>
            <p className={styles.note}>
              The console caches preferences (theme, morning routine) in this browser. Your account data lives in
              Supabase and is governed by row-level security.
            </p>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Cached items</span>
              <span className={styles.kvVal}>{localItemCount}</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button type="button" className="savebtn" onClick={exportLocalData}>
                Export local data
              </button>
              <button type="button" className={styles.dangerBtn} onClick={() => setClearOpen(true)}>
                Clear local data
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------- APPEARANCE */}
      <div className={tab === "appearance" ? "subpanel on" : "subpanel"}>
        <div className={styles.grid2}>
          <div className="card tick">
            <h2 className="sec">
              Current Theme<span className="rule" />
            </h2>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Mode</span>
              <span className={styles.kvVal}>{THEME_LABEL[theme] ?? theme}</span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Accent</span>
              <span className={styles.kvVal} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    display: "inline-block",
                    background: `linear-gradient(135deg, ${ACCENT_PRESETS[interfaceSettings.accent]?.accent}, ${ACCENT_PRESETS[interfaceSettings.accent]?.accent2})`,
                  }}
                />
                {accentLabel}
              </span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Surface tone</span>
              <span className={styles.kvVal} style={{ textTransform: "capitalize" }}>
                {interfaceSettings.surfaceTone}
              </span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Corner radius</span>
              <span className={styles.kvVal}>{interfaceSettings.cornerRadius}px</span>
            </div>
          </div>

          <div className="card">
            <h2 className="sec">
              Type &amp; Layout<span className="rule" />
            </h2>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Display face</span>
              <span className={styles.kvVal}>{FACE_LABEL[interfaceSettings.displayFace] ?? interfaceSettings.displayFace}</span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Body face</span>
              <span className={styles.kvVal}>{FACE_LABEL[interfaceSettings.bodyFace] ?? interfaceSettings.bodyFace}</span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Density</span>
              <span className={styles.kvVal} style={{ textTransform: "capitalize" }}>
                {interfaceSettings.density}
              </span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Companion</span>
              <span className={styles.kvVal} style={{ textTransform: "capitalize" }}>
                {interfaceSettings.companion}
              </span>
            </div>
            <div className={styles.kv}>
              <span className={styles.kvKey}>Presence</span>
              <span className={styles.kvVal} style={{ textTransform: "capitalize" }}>
                {interfaceSettings.presence}
              </span>
            </div>
            <button type="button" className="savebtn" style={{ marginTop: 14 }} onClick={openInterfaceStudio}>
              Open Interface Studio
            </button>
            <p className={styles.note}>Full controls — mode, accent, faces, density — live in the Interface Studio drawer.</p>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- ACTIVITY */}
      <div className={tab === "activity" ? "subpanel on" : "subpanel"}>
        <div className="card">
          <h2 className="sec">
            Recent Activity<span className="rule" />
          </h2>
          {activity === null ? (
            <p className={styles.note}>Loading…</p>
          ) : activity.length === 0 ? (
            <div className="empty-state">
              <div>No recent activity</div>
              <p>Create a note, capture a signal, or add a task and it will appear here.</p>
            </div>
          ) : (
            <div className={styles.feed}>
              {activity.map((a, i) => (
                <div key={`${a.kind}-${i}`} className={styles.feedItem}>
                  <span className={styles.feedWhen}>{relTime(a.at)}</span>
                  <span className={styles.feedText}>
                    <span className={styles.feedKind}>{a.kind}</span>
                    {a.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ----------------------------------------------------------------- MODALS */}
      <Modal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear local data"
        footer={
          <button type="button" className={styles.dangerBtn} onClick={clearLocalData}>
            Clear &amp; reload
          </button>
        }
      >
        <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
          This removes cached preferences (theme, interface settings, morning routine) from this browser only. Your
          account data in Supabase is untouched. The page will reload afterward.
        </p>
      </Modal>

      <Modal
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        title="Sign out"
        footer={
          <button type="button" className={styles.dangerBtn} onClick={doSignOut}>
            Sign out
          </button>
        }
      >
        <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
          End your session on this device. You can sign back in at any time.
        </p>
      </Modal>
    </>
  );
}
