"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ACCENT_PRESETS } from "@/lib/theme/interface-settings";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/calendar/event-dates";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import styles from "./ControlRoom.module.css";
import { MFASetup } from "@/components/auth/MFASetup";
import { usePasskey } from "@/hooks/usePasskey";
import { openComposioOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { Seg } from "@/components/ui/Seg";
import { AxisGlassPanel } from "@/components/ui/axis/AxisGlassPanel";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";
import type { AIProviderPref } from "@/lib/ai/router";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "connections", label: "Connections" },
  { id: "data", label: "Data & Privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "security", label: "Security" },
  { id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type ConnState = "on" | "off" | "pending" | "broken";

type ComposioToolkit = "gmail" | "outlook" | "strava" | "spotify" | "googlecalendar" | "googlecontacts";

type ComposioConnection = {
  id: string;
  toolkit: ComposioToolkit;
  connected_account_id: string;
  status: string;
  account_label: string | null;
  created_at: string;
};

type MailAccount = {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via?: "composio";
  connectedAccountId?: string;
};

type CalendarStatus = {
  google: boolean;
  googleEmail: string | null;
  outlook: boolean;
  outlookEmail: string | null;
};

type ContactsStatus = {
  google: boolean;
  googleEmail: string | null;
  via: "oauth" | "composio" | null;
};

type OAuthProviderStatus = {
  connected: boolean;
  label: string | null;
};

type StatusSource = "mail" | "calendar" | "contacts" | "composio" | "spotify" | "strava";

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

type ConnectionAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
};

type ConnectionRow = {
  name: string;
  desc: string;
  state: ConnState;
  detail: string;
  action?: ConnectionAction;
  secondaryAction?: ConnectionAction;
};

const BROKEN_COMPOSIO_STATUSES = new Set(["FAILED", "EXPIRED", "REVOKED"]);

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

function humanizeComposioStatus(status: string): string {
  const normalized = status.trim().toUpperCase();
  if (normalized === "ACTIVE") return "Connected";
  if (normalized === "INITIATED" || normalized === "INITIALIZING") return "Finishing authorization";
  if (normalized === "EXPIRED") return "Authorization expired";
  if (normalized === "REVOKED") return "Access revoked";
  if (normalized === "FAILED") return "Authorization failed";
  return normalized.replaceAll("_", " ").toLowerCase();
}

function pickComposioConnection(
  connections: ComposioConnection[] | null,
  toolkits: ComposioToolkit[],
): ComposioConnection | null {
  const matches = (connections ?? [])
    .filter((connection) => toolkits.includes(connection.toolkit))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    matches.find((connection) => connection.status === "ACTIVE") ??
    matches.find((connection) => BROKEN_COMPOSIO_STATUSES.has(connection.status)) ??
    matches[0] ??
    null
  );
}

function composioState(connection: ComposioConnection | null): ConnState {
  if (!connection) return "off";
  if (connection.status === "ACTIVE") return "on";
  if (BROKEN_COMPOSIO_STATUSES.has(connection.status)) return "broken";
  return "pending";
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
  const [aiProvider, setAiProvider] = useState<AIProviderPref>("auto");
  const [aiProviderSaving, setAiProviderSaving] = useState(false);
  const [spotifyStatus, setSpotifyStatus] = useState<OAuthProviderStatus | null>(null);
  const [stravaStatus, setStravaStatus] = useState<OAuthProviderStatus | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<ServiceStatus | null>(null);
  const [plaidStatus, setPlaidStatus] = useState<ServiceStatus | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [mailAccounts, setMailAccounts] = useState<MailAccount[] | null>(null);
  const [contactsStatus, setContactsStatus] = useState<ContactsStatus | null>(null);
  const [composioConnections, setComposioConnections] = useState<ComposioConnection[] | null>(null);
  const [statusErrors, setStatusErrors] = useState<Partial<Record<StatusSource, string>>>({});
  const [lastStatusRefresh, setLastStatusRefresh] = useState<string | null>(null);

  const setStatusError = useCallback((source: StatusSource, message: string | null) => {
    setStatusErrors((prev) => {
      const next = { ...prev };
      if (message) next[source] = message;
      else delete next[source];
      return next;
    });
  }, []);

  const refreshMailStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/mail/status", { cache: "no-store" });
      if (!res.ok) throw new Error("Mail status unavailable");
      const { accounts } = (await res.json()) as {
        accounts: MailAccount[];
      };
      setMailAccounts(accounts);
      setStatusError("mail", null);
    } catch {
      setMailAccounts([]);
      setStatusError("mail", "Mail status unavailable.");
    }
  }, [setStatusError]);

  const refreshComposioStatus = useCallback(async () => {
    // Hitting the status route triggers Composio's poll-on-read, which flips a
    // freshly-connected account to ACTIVE in our DB. The raw list also powers
    // the reconnect states for failed/expired provider accounts in this panel.
    try {
      const res = await fetch("/api/integrations/composio/status", { cache: "no-store" });
      if (!res.ok) throw new Error("Composio status unavailable");
      const json = (await res.json()) as { connections?: ComposioConnection[] };
      setComposioConnections(json.connections ?? []);
      setStatusError("composio", null);
    } catch {
      setComposioConnections([]);
      setStatusError("composio", "Composio status unavailable.");
    }
  }, [setStatusError]);

  const refreshCalendarStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/status", { cache: "no-store" });
      if (!res.ok) throw new Error("Calendar status unavailable");
      setCalendarStatus(await res.json());
      setStatusError("calendar", null);
    } catch {
      setCalendarStatus({ google: false, googleEmail: null, outlook: false, outlookEmail: null });
      setStatusError("calendar", "Calendar status unavailable.");
    }
  }, [setStatusError]);

  const refreshContactsStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/contacts/status", { cache: "no-store" });
      if (!res.ok) throw new Error("Contacts status unavailable");
      setContactsStatus(await res.json());
      setStatusError("contacts", null);
    } catch {
      setContactsStatus({ google: false, googleEmail: null, via: null });
      setStatusError("contacts", "Contacts status unavailable.");
    }
  }, [setStatusError]);

  const refreshSpotifyStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/spotify/playback", { cache: "no-store" });
      if (!res.ok) throw new Error("Spotify status unavailable");
      const json = (await res.json()) as { connected?: boolean };
      setSpotifyStatus({ connected: !!json.connected, label: null });
      setStatusError("spotify", null);
    } catch {
      setSpotifyStatus({ connected: false, label: null });
      setStatusError("spotify", "Spotify status unavailable.");
    }
  }, [setStatusError]);

  const refreshStravaStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/strava?action=status", { cache: "no-store" });
      if (!res.ok) throw new Error("Strava status unavailable");
      const json = (await res.json()) as { connected?: boolean; athlete?: { name?: string | null } | null };
      setStravaStatus({ connected: !!json.connected, label: json.athlete?.name ?? null });
      setStatusError("strava", null);
    } catch {
      setStravaStatus({ connected: false, label: null });
      setStatusError("strava", "Strava status unavailable.");
    }
  }, [setStatusError]);

  // Activity ---------------------------------------------------------------
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [counts, setCounts] = useState<{ notes: number; signals: number; tasks: number; events: number } | null>(null);

  // Modals -----------------------------------------------------------------
  const [clearOpen, setClearOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  // Auth settings (security tab) ------------------------------------------
  const [authSettings, setAuthSettings] = useState<{
    passkey_enabled: boolean;
    biometric_prompted: boolean;
    twofa_enabled: boolean;
    twofa_method: string | null;
    recovery_email: string | null;
    mfa_factors: { id: string; type: string; status: string }[];
  } | null>(null);
  const [passkeys, setPasskeys] = useState<{ id: string; name: string; device_type: string; created_at: string; last_used_at: string | null }[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [passkeyRegistering, setPasskeyRegistering] = useState(false);
  const { register: registerPasskey } = usePasskey();

  // Account change modals
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [recoveryEmailOpen, setRecoveryEmailOpen] = useState(false);

  // Form values for account changes
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");

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
        .select("display_name, role_title, ai_provider")
        .eq("id", u.id)
        .maybeSingle();
      if (profile) {
        displayName = profile.display_name ?? null;
        roleTitle = profile.role_title ?? null;
        setAiProvider((profile.ai_provider as AIProviderPref) ?? "gemini");
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
      await refreshComposioStatus();
      if (!alive) return;
      await Promise.all([
        refreshSpotifyStatus(),
        refreshStravaStatus(),
        refreshCalendarStatus(),
        refreshMailStatus(),
        refreshContactsStatus(),
      ]);
      if (alive) setLastStatusRefresh(new Date().toISOString());
    })();
    return () => {
      alive = false;
    };
  }, [
    refreshCalendarStatus,
    refreshContactsStatus,
    refreshComposioStatus,
    refreshMailStatus,
    refreshSpotifyStatus,
    refreshStravaStatus,
  ]);

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

  const saveAiProvider = useCallback(async (pref: AIProviderPref) => {
    setAiProvider(pref);
    setAiProviderSaving(true);
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await supabase.from("profiles").update({ ai_provider: pref }).eq("id", data.user.id);
    }
    setAiProviderSaving(false);
  }, [supabase]);

  // --- Load security settings when security tab is active ----------------
  useEffect(() => {
    if (tab !== "security") return;
    let alive = true;
    setSecurityLoading(true);
    Promise.all([
      fetch("/api/auth/settings").then((r) => r.json()),
      fetch("/api/auth/passkey/list").then((r) => r.json()).catch(() => []),
    ]).then(([settings, pkList]) => {
      if (!alive) return;
      setAuthSettings(settings);
      setPasskeys(Array.isArray(pkList) ? pkList : (pkList.passkeys ?? []));
      setSecurityLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [tab]);

  // --- Actions ------------------------------------------------------------
  const connectSpotify = () => {
    openComposioOAuthPopup("spotify", (status) => {
      if (status === "ok") void refreshAfterComposio();
    });
  };

  const connectStrava = () => {
    openComposioOAuthPopup("strava", (status) => {
      if (status === "ok") void refreshAfterComposio();
    });
  };

  // After any Composio connect/disconnect, refresh every status the change could
  // touch: the raw Composio list first, then the merged views that read those
  // rows from Supabase.
  const refreshAfterComposio = useCallback(async () => {
    await refreshComposioStatus();
    await Promise.all([
      refreshMailStatus(),
      refreshCalendarStatus(),
      refreshContactsStatus(),
      refreshSpotifyStatus(),
      refreshStravaStatus(),
    ]);
  }, [
    refreshCalendarStatus,
    refreshContactsStatus,
    refreshComposioStatus,
    refreshMailStatus,
    refreshSpotifyStatus,
    refreshStravaStatus,
  ]);

  const connectComposioToolkit = (toolkit: ComposioToolkit) => {
    openComposioOAuthPopup(toolkit, (status) => {
      if (status === "ok") void refreshAfterComposio();
    });
  };

  const disconnectComposioToolkit = async (toolkit: ComposioToolkit) => {
    const res = await fetch(`/api/integrations/composio/disconnect?toolkit=${toolkit}`, { method: "DELETE" });
    if (!res.ok) {
      toast("Could not disconnect provider.", "error", "Connections");
      return;
    }
    await refreshAfterComposio();
  };

  const disconnectMailAccount = async (provider: "gmail" | "outlook", account: MailAccount) => {
    const url =
      account.via === "composio"
        ? `/api/integrations/composio/disconnect?toolkit=${provider}`
        : `/api/mail/disconnect?provider=${provider}&email=${encodeURIComponent(account.mailEmail)}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      toast("Could not disconnect mail.", "error", "Connections");
      return;
    }
    await refreshAfterComposio();
  };

  const disconnectCalendarProvider = async (provider: "google" | "outlook") => {
    const res = await fetch(`/api/calendar/disconnect?provider=${provider}`, { method: "DELETE" });
    if (!res.ok) {
      toast("Could not disconnect calendar.", "error", "Connections");
      return;
    }
    await refreshAfterComposio();
  };

  const disconnectSpotify = async () => {
    const res = await fetch("/api/spotify/disconnect", { method: "POST" });
    if (!res.ok) {
      toast("Could not disconnect Spotify.", "error", "Connections");
      return;
    }
    await refreshSpotifyStatus();
  };

  const disconnectStrava = async () => {
    const res = await fetch("/api/strava?action=disconnect");
    if (!res.ok) {
      toast("Could not disconnect Strava.", "error", "Connections");
      return;
    }
    await refreshStravaStatus();
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
      a.download = `axis-local-data-${todayLocalIso()}.json`;
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

  const deletePasskey = async (passkeyId: string) => {
    const res = await fetch("/api/auth/passkey/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId }),
    });
    if (res.ok) {
      setPasskeys((prev) => prev.filter((p) => p.id !== passkeyId));
      toast("Passkey removed", "success", "Security");
      if (passkeys.length <= 1) setAuthSettings((prev) => (prev ? { ...prev, passkey_enabled: false } : prev));
    } else {
      toast("Failed to remove passkey", "error", "Security");
    }
  };

  const unenrollMFA = async () => {
    const factor = authSettings?.mfa_factors?.find((f) => f.type === "totp");
    if (!factor) return;
    const res = await fetch("/api/auth/mfa/unenroll", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factorId: factor.id }),
    });
    if (res.ok) {
      setAuthSettings((prev) => (prev ? { ...prev, twofa_enabled: false, mfa_factors: [] } : prev));
      toast("2FA disabled", "success", "Security");
    }
  };

  const changePassword = async () => {
    if (newPassword !== newPasswordConfirm) { toast("Passwords don't match", "error", "Security"); return; }
    if (newPassword.length < 8) { toast("Password must be at least 8 characters", "error", "Security"); return; }
    const res = await fetch("/api/auth/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change_password", password: newPassword }),
    });
    const data = await res.json();
    if (res.ok) {
      setChangePasswordOpen(false);
      setNewPassword("");
      setNewPasswordConfirm("");
      toast("Password updated", "success", "Security");
    } else {
      toast(data.error ?? "Update failed", "error", "Security");
    }
  };

  const changeEmail = async () => {
    if (!newEmail) return;
    const res = await fetch("/api/auth/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change_email", email: newEmail }),
    });
    const data = await res.json();
    if (res.ok) {
      setChangeEmailOpen(false);
      setNewEmail("");
      toast("Confirmation sent to " + newEmail, "success", "Security");
    } else {
      toast(data.error ?? "Update failed", "error", "Security");
    }
  };

  const saveRecoveryEmail = async () => {
    const res = await fetch("/api/auth/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recovery_email: recoveryEmail || null }),
    });
    if (res.ok) {
      setRecoveryEmailOpen(false);
      setAuthSettings((prev) => (prev ? { ...prev, recovery_email: recoveryEmail || null } : prev));
      toast("Recovery email saved", "success", "Security");
    }
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

  const sourceError = (...sources: StatusSource[]) => sources.map((source) => statusErrors[source]).find(Boolean) ?? null;
  const isActiveComposio = (connection: ComposioConnection | null) => connection?.status === "ACTIVE";
  const composioDetail = (connection: ComposioConnection | null, disconnected = "Not connected") => {
    if (!connection) return disconnected;
    const label = connection.account_label;
    if (connection.status === "ACTIVE") return `${label ?? "Connected account"} via Composio`;
    const prefix = label ? `${label} · ` : "";
    const suffix = BROKEN_COMPOSIO_STATUSES.has(connection.status)
      ? "Reconnect to restore access."
      : "Finish provider authorization.";
    return `${prefix}${humanizeComposioStatus(connection.status)}. ${suffix}`;
  };
  const composioConnectAction = (toolkit: ComposioToolkit, state: ConnState): ConnectionAction => ({
    label: state === "broken" ? "Reconnect" : state === "pending" ? "Continue" : "Connect",
    onClick: () => connectComposioToolkit(toolkit),
  });

  const gmailAccount = mailAccounts?.find((account) => account.provider === "gmail") ?? null;
  const outlookAccount = mailAccounts?.find((account) => account.provider === "outlook") ?? null;
  const gmailComposio = pickComposioConnection(composioConnections, ["gmail"]);
  const outlookComposio = pickComposioConnection(composioConnections, ["outlook"]);
  const googleCalendarComposio = pickComposioConnection(composioConnections, ["googlecalendar"]);
  const contactsComposio = pickComposioConnection(composioConnections, ["googlecontacts"]);
  const spotifyComposio = pickComposioConnection(composioConnections, ["spotify"]);
  const stravaComposio = pickComposioConnection(composioConnections, ["strava"]);

  const gmailState: ConnState =
    gmailAccount || isActiveComposio(gmailComposio)
      ? "on"
      : mailAccounts === null || composioConnections === null
        ? "pending"
        : sourceError("mail", "composio")
          ? "broken"
          : composioState(gmailComposio);
  const outlookConnected = !!outlookAccount || !!calendarStatus?.outlook || isActiveComposio(outlookComposio);
  const outlookState: ConnState =
    outlookConnected
      ? "on"
      : mailAccounts === null || calendarStatus === null || composioConnections === null
        ? "pending"
        : sourceError("mail", "calendar", "composio")
          ? "broken"
          : composioState(outlookComposio);
  const googleCalendarState: ConnState =
    calendarStatus?.google || isActiveComposio(googleCalendarComposio)
      ? "on"
      : calendarStatus === null || composioConnections === null
        ? "pending"
        : sourceError("calendar", "composio")
          ? "broken"
          : composioState(googleCalendarComposio);
  const contactsState: ConnState =
    contactsStatus?.google || isActiveComposio(contactsComposio)
      ? "on"
      : contactsStatus === null || composioConnections === null
        ? "pending"
        : sourceError("contacts", "composio")
          ? "broken"
          : composioState(contactsComposio);
  const spotifyState: ConnState =
    spotifyStatus?.connected
      ? "on"
      : spotifyStatus === null || composioConnections === null
        ? "pending"
        : sourceError("spotify", "composio")
          ? "broken"
          : composioState(spotifyComposio);
  const stravaState: ConnState =
    stravaStatus?.connected
      ? "on"
      : stravaStatus === null || composioConnections === null
        ? "pending"
        : sourceError("strava", "composio")
          ? "broken"
          : composioState(stravaComposio);

  const providerRows: ConnectionRow[] = [
    {
      name: "Gmail",
      desc: "Mail triage, message detail, and send workflows",
      state: gmailState,
      detail: gmailAccount
        ? `${gmailAccount.mailEmail} via ${gmailAccount.via === "composio" ? "Composio" : "OAuth"}`
        : gmailState === "pending"
          ? "Checking..."
          : sourceError("mail", "composio") && !gmailComposio
            ? sourceError("mail", "composio")!
            : composioDetail(gmailComposio),
      action:
        gmailState === "on" && gmailAccount
          ? { label: "Disconnect", onClick: () => void disconnectMailAccount("gmail", gmailAccount) }
          : gmailState === "off" || gmailState === "broken" || (gmailState === "pending" && gmailComposio)
            ? composioConnectAction("gmail", gmailState)
            : undefined,
    },
    {
      name: "Outlook",
      desc: "Microsoft mail and calendar access",
      state: outlookState,
      detail: outlookConnected
        ? `${outlookAccount?.mailEmail ?? calendarStatus?.outlookEmail ?? outlookComposio?.account_label ?? "Microsoft 365"} via ${
            outlookAccount?.via === "composio" || isActiveComposio(outlookComposio) ? "Composio" : "OAuth"
          }`
        : outlookState === "pending"
          ? "Checking..."
          : sourceError("mail", "calendar", "composio") && !outlookComposio
            ? sourceError("mail", "calendar", "composio")!
            : composioDetail(outlookComposio),
      action:
        outlookState === "on"
          ? {
              label: "Disconnect",
              onClick: async () => {
                if (outlookAccount?.via === "composio" || isActiveComposio(outlookComposio)) {
                  await disconnectComposioToolkit("outlook");
                  return;
                }
                if (outlookAccount) await disconnectMailAccount("outlook", outlookAccount);
                if (calendarStatus?.outlook) await disconnectCalendarProvider("outlook");
              },
            }
          : outlookState === "off" || outlookState === "broken" || (outlookState === "pending" && outlookComposio)
            ? composioConnectAction("outlook", outlookState)
            : undefined,
    },
    {
      name: "Google Calendar",
      desc: "Schedule sync and calendar conflict checks",
      state: googleCalendarState,
      detail: isActiveComposio(googleCalendarComposio)
        ? composioDetail(googleCalendarComposio, "Google Calendar via Composio")
        : calendarStatus?.google
          ? `${calendarStatus.googleEmail ?? "Google Calendar"} via OAuth`
          : googleCalendarState === "pending"
            ? "Checking..."
            : sourceError("calendar", "composio") && !googleCalendarComposio
              ? sourceError("calendar", "composio")!
              : composioDetail(googleCalendarComposio),
      action:
        googleCalendarState === "on"
          ? {
              label: "Disconnect",
              onClick: () =>
                void (isActiveComposio(googleCalendarComposio)
                  ? disconnectComposioToolkit("googlecalendar")
                  : disconnectCalendarProvider("google")),
            }
          : googleCalendarState === "off" || googleCalendarState === "broken" || (googleCalendarState === "pending" && googleCalendarComposio)
            ? composioConnectAction("googlecalendar", googleCalendarState)
            : undefined,
    },
    {
      name: "Google Contacts",
      desc: "People sync and CRM matching",
      state: contactsState,
      detail: contactsStatus?.google
        ? `${contactsStatus.googleEmail ?? "Google Contacts"} via ${contactsStatus.via === "composio" ? "Composio" : "OAuth"}`
        : isActiveComposio(contactsComposio)
          ? composioDetail(contactsComposio)
          : contactsState === "pending"
            ? "Checking..."
            : sourceError("contacts", "composio") && !contactsComposio
              ? sourceError("contacts", "composio")!
              : composioDetail(contactsComposio),
      action:
        contactsState === "on" && (contactsStatus?.via === "composio" || isActiveComposio(contactsComposio))
          ? { label: "Disconnect", onClick: () => void disconnectComposioToolkit("googlecontacts") }
          : contactsState === "off" || contactsState === "broken" || (contactsState === "pending" && contactsComposio)
            ? composioConnectAction("googlecontacts", contactsState)
            : undefined,
    },
    {
      name: "Spotify",
      desc: "Listening Vault, search, library, and miniplayer",
      state: spotifyState,
      detail: spotifyStatus?.connected
        ? `${spotifyStatus.label ?? "Spotify account"} via OAuth`
        : isActiveComposio(spotifyComposio)
          ? composioDetail(spotifyComposio)
          : spotifyState === "pending"
            ? "Checking..."
            : sourceError("spotify", "composio") && !spotifyComposio
              ? sourceError("spotify", "composio")!
              : composioDetail(spotifyComposio, "Not connected"),
      action:
        spotifyState === "on"
          ? {
              label: "Disconnect",
              onClick: () =>
                void (spotifyStatus?.connected ? disconnectSpotify() : disconnectComposioToolkit("spotify")),
            }
          : spotifyState === "broken" && spotifyComposio
            ? composioConnectAction("spotify", spotifyState)
            : spotifyState === "broken"
              ? { label: "Retry", onClick: () => void refreshSpotifyStatus() }
              : spotifyState === "off"
                ? { label: "Connect", onClick: connectSpotify }
                : spotifyState === "pending" && spotifyComposio
                  ? composioConnectAction("spotify", spotifyState)
                  : undefined,
      secondaryAction: spotifyState === "off" ? { label: "Via Composio", onClick: () => connectComposioToolkit("spotify"), variant: "secondary" } : undefined,
    },
    {
      name: "Strava",
      desc: "Vitality activity, training load, and plan context",
      state: stravaState,
      detail: stravaStatus?.connected
        ? `${stravaStatus.label ?? "Strava athlete"} via OAuth`
        : isActiveComposio(stravaComposio)
          ? composioDetail(stravaComposio)
          : stravaState === "pending"
            ? "Checking..."
            : sourceError("strava", "composio") && !stravaComposio
              ? sourceError("strava", "composio")!
              : composioDetail(stravaComposio, "Not connected"),
      action:
        stravaState === "on"
          ? {
              label: "Disconnect",
              onClick: () => void (stravaStatus?.connected ? disconnectStrava() : disconnectComposioToolkit("strava")),
            }
          : stravaState === "broken" && stravaComposio
            ? composioConnectAction("strava", stravaState)
            : stravaState === "broken"
              ? { label: "Retry", onClick: () => void refreshStravaStatus() }
              : stravaState === "off"
                ? { label: "Connect", onClick: connectStrava }
                : stravaState === "pending" && stravaComposio
                  ? composioConnectAction("strava", stravaState)
                  : undefined,
      secondaryAction: stravaState === "off" ? { label: "Via Composio", onClick: () => connectComposioToolkit("strava"), variant: "secondary" } : undefined,
    },
  ];

  // --- Service definitions for the Connections tab ------------------------
  const serviceConnections: ConnectionRow[] = [
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

  const overviewConnections = [...serviceConnections.slice(1), ...providerRows];
  const allConnections = [...serviceConnections, ...providerRows];
  const connectedCount = allConnections.filter((c) => c.state === "on").length;

  const activeTabLabel = TABS.find((t) => t.id === tab)?.label ?? "Overview";

  return (
    <>
      <div className="module-stage control-room-stage">
        <AxisReflectiveCard className="module-hero-shell module-hero-shell--compact">
          <div className="eyebrow">System · Control Room</div>
          <h1 className="hero-title">{activeTabLabel}</h1>
          <p className="sub mail-hero-meta">
            {connectedCount} of {allConnections.length} connections live
          </p>
        </AxisReflectiveCard>

        <AxisGlassPanel className="module-glass-zone control-room-workspace">
          <div className="subtabbar">
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
                    {connectedCount} / {allConnections.length}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <div className="card">
            <h2 className="sec">
              Services<span className="rule" />
            </h2>
            {overviewConnections.map((c) => (
              <div key={c.name} className={styles.svcRow}>
                <span className={styles.svcDot} data-state={c.state} />
                <div className={styles.svcBody}>
                  <div className={styles.svcName}>{c.name}</div>
                  <div className={styles.svcDesc}>{c.detail}</div>
                </div>
                {c.state !== "on" && c.state !== "pending" ? (
                  <button
                    type="button"
                    className={styles.svcAction}
                    onClick={() => (c.action ? c.action.onClick() : setTab("connections"))}
                  >
                    {c.action?.label ?? "Review"}
                  </button>
                ) : (
                  <span className={styles.svcState} data-state={c.state}>
                    {c.state === "on" ? "Live" : "…"}
                  </span>
                )}
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
            Provider Accounts<span className="rule" />
          </h2>
          <p className={styles.note} style={{ marginBottom: 4 }}>
            Live status is read from existing server routes and connection rows. Credentials and environment values stay server-side.
            {lastStatusRefresh ? ` Last checked ${relTime(lastStatusRefresh)}.` : ""}
          </p>
          {providerRows.map((c) => (
            <div key={c.name} className={styles.svcRow}>
              <span className={styles.svcDot} data-state={c.state} />
              <div className={styles.svcBody}>
                <div className={styles.svcName}>{c.name}</div>
                <div className={styles.svcDesc}>
                  {c.desc} — {c.detail}
                </div>
              </div>
              {c.action || c.secondaryAction ? (
                <div className={styles.svcActions}>
                  {c.action && (
                    <button type="button" className={styles.svcAction} data-variant={c.action.variant} onClick={c.action.onClick}>
                      {c.action.label}
                    </button>
                  )}
                  {c.secondaryAction && (
                    <button type="button" className={styles.svcAction} data-variant={c.secondaryAction.variant} onClick={c.secondaryAction.onClick}>
                      {c.secondaryAction.label}
                    </button>
                  )}
                </div>
              ) : (
                <span className={styles.svcState} data-state={c.state}>
                  {c.state === "on" ? "Connected" : c.state === "pending" ? "Checking" : c.state === "broken" ? "Reconnect" : "Not set"}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="sec">
            Platform Services<span className="rule" />
          </h2>
          {serviceConnections.map((c) => (
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
                  {c.state === "on" ? "Configured" : c.state === "pending" ? "Checking" : c.state === "broken" ? "Review" : "Not set"}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="sec">
            AI Model<span className="rule" />
          </h2>
          <p className={styles.note} style={{ marginBottom: 10 }}>
            Auto picks the cheapest capable model per task (Gemini for quick classification, Claude for writing and
            conversation). Forcing a provider routes every AI feature through it instead, falling back to the other
            only if it&rsquo;s unavailable. Semantic search always uses Gemini&rsquo;s embedding model regardless of this
            setting — switching embedding providers would break existing search results.
          </p>
          <Seg<AIProviderPref>
            options={[
              { label: "Auto", value: "auto" },
              { label: "Gemini", value: "gemini" },
              { label: "Claude", value: "anthropic" },
            ]}
            value={aiProvider}
            onChange={(v) => void saveAiProvider(v)}
          />
          {aiProviderSaving && <p className={styles.note} style={{ marginTop: 8 }}>Saving…</p>}
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

          <div className="card">
            <h2 className="sec">
              Legal<span className="rule" />
            </h2>
            <p className={styles.note}>
              Review the legal documents governing your use of Axis.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button
                type="button"
                className="savebtn"
                onClick={() => window.open("/terms", "_blank", "width=720,height=900,noopener")}
              >
                Terms of Service ↗
              </button>
              <button
                type="button"
                className="savebtn"
                onClick={() => window.open("/privacy", "_blank", "width=720,height=900,noopener")}
              >
                Privacy Policy ↗
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

      {/* --------------------------------------------------------------- SECURITY */}
      <div className={tab === "security" ? "subpanel on" : "subpanel"}>
        {securityLoading ? (
          <p className={styles.note}>Loading security settings…</p>
        ) : (
          <div className={styles.grid2}>
            {/* Passkeys */}
            <div className="card tick">
              <h2 className="sec">
                Passkeys<span className="rule" />
              </h2>
              <p className={styles.note}>
                Sign in with Face ID, Touch ID, or Windows Hello — no password needed.
              </p>
              {passkeys.length === 0 ? (
                <p className={styles.note} style={{ color: "var(--ink-dim)" }}>No passkeys registered.</p>
              ) : (
                passkeys.map((pk) => (
                  <div key={pk.id} className={styles.svcRow}>
                    <div className={styles.svcBody}>
                      <div className={styles.svcName}>{pk.name}</div>
                      <div className={styles.svcDesc}>
                        {pk.device_type === "platform" ? "This device" : "External key"}
                        {pk.last_used_at ? ` · last used ${relTime(pk.last_used_at)}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      style={{ fontSize: 11 }}
                      onClick={() => deletePasskey(pk.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
              <button
                type="button"
                className="savebtn"
                style={{ marginTop: 12 }}
                disabled={passkeyRegistering}
                onClick={async () => {
                  setPasskeyRegistering(true);
                  const result = await registerPasskey();
                  setPasskeyRegistering(false);
                  if (!result.ok) {
                    toast(result.error ?? "Registration failed", "error", "Security");
                    return;
                  }
                  toast("Passkey registered", "success", "Security");
                  fetch("/api/auth/passkey/list")
                    .then((r) => r.json())
                    .then((list) => setPasskeys(Array.isArray(list) ? list : (list.passkeys ?? [])));
                }}
              >
                {passkeyRegistering ? "Waiting for device…" : "Add passkey"}
              </button>
            </div>

            {/* 2FA */}
            <div className="card">
              <h2 className="sec">
                Two-Factor Auth<span className="rule" />
              </h2>
              <p className={styles.note}>
                Require a code from your authenticator app on each sign-in.
              </p>
              <div className={styles.kv}>
                <span className={styles.kvKey}>Status</span>
                <span className={styles.kvVal} style={{ color: authSettings?.twofa_enabled ? "var(--up)" : "var(--ink-dim)" }}>
                  {authSettings?.twofa_enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {authSettings?.twofa_enabled ? (
                <button type="button" className={styles.dangerBtn} style={{ marginTop: 12 }} onClick={unenrollMFA}>
                  Disable 2FA
                </button>
              ) : (
                <button type="button" className="savebtn" style={{ marginTop: 12 }} onClick={() => setMfaSetupOpen(true)}>
                  Set up 2FA
                </button>
              )}
              {authSettings?.passkey_enabled && (
                <p className={styles.note} style={{ marginTop: 8 }}>
                  2FA is skipped when signing in with a passkey.
                </p>
              )}
            </div>

            {/* Account */}
            <div className="card tick">
              <h2 className="sec">
                Account<span className="rule" />
              </h2>
              <div className={styles.kv}>
                <span className={styles.kvKey}>Email</span>
                <span className={styles.kvVal}>{user?.email}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" className="savebtn" onClick={() => setChangeEmailOpen(true)}>
                  Change email
                </button>
                <button type="button" className="savebtn" onClick={() => setChangePasswordOpen(true)}>
                  Change password
                </button>
              </div>
            </div>

            {/* Recovery */}
            <div className="card">
              <h2 className="sec">
                Recovery<span className="rule" />
              </h2>
              <p className={styles.note}>
                A secondary email used to reset your password if you lose access to your primary.
              </p>
              <div className={styles.kv}>
                <span className={styles.kvKey}>Recovery email</span>
                <span className={styles.kvVal}>{authSettings?.recovery_email ?? "—"}</span>
              </div>
              <button
                type="button"
                className="savebtn"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setRecoveryEmail(authSettings?.recovery_email ?? "");
                  setRecoveryEmailOpen(true);
                }}
              >
                {authSettings?.recovery_email ? "Change recovery email" : "Add recovery email"}
              </button>
            </div>
          </div>
        )}
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
        </AxisGlassPanel>
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

      {/* Change password */}
      <Modal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
        title="Change password"
        footer={
          <button type="button" className="savebtn" onClick={changePassword}>
            Update password
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={newPasswordConfirm}
            onChange={(e) => setNewPasswordConfirm(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      </Modal>

      {/* Change email */}
      <Modal
        open={changeEmailOpen}
        onClose={() => setChangeEmailOpen(false)}
        title="Change email"
        footer={
          <button type="button" className="savebtn" onClick={changeEmail}>
            Send confirmation
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
            A confirmation link will be sent to your new email address. Your email won&apos;t change until you click
            the link.
          </p>
          <input
            type="email"
            placeholder="New email address"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      </Modal>

      {/* Recovery email */}
      <Modal
        open={recoveryEmailOpen}
        onClose={() => setRecoveryEmailOpen(false)}
        title="Recovery email"
        footer={
          <button type="button" className="savebtn" onClick={saveRecoveryEmail}>
            Save
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.6 }}>
            Used to reset your password if you lose access to your primary email. This does not change your sign-in
            email.
          </p>
          <input
            type="email"
            placeholder="Recovery email address"
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      </Modal>

      {/* MFA setup */}
      <Modal
        open={mfaSetupOpen}
        onClose={() => setMfaSetupOpen(false)}
        title="Set up two-factor authentication"
      >
        <MFASetup
          onSuccess={() => {
            setMfaSetupOpen(false);
            setAuthSettings((prev) => (prev ? { ...prev, twofa_enabled: true } : prev));
            toast("2FA enabled", "success", "Security");
          }}
          onClose={() => setMfaSetupOpen(false)}
        />
      </Modal>
    </>
  );
}
