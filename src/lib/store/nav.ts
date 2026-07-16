export type NavItem = {
  href: string;
  label: string;
  icon: string;
  title?: string;
  ix?: string;
  status?: "production" | "beta" | "lab" | "soon";
  statusReason?: string;
  statusAction?: string;
};

export type NavGroup = { section: string; items: NavItem[] };

export const DEFAULT_NAV: NavGroup[] = [
  { section: "Daily", items: [
    { href: "/command", label: "Command", icon: "console", status: "production" },
    { href: "/dispatch", label: "Dispatch", icon: "signals", title: "Dispatch — triage incoming items", status: "production" },
    { href: "/schedule", label: "Schedule", icon: "calendar", title: "Schedule — week, month, day views", status: "production" },
    { href: "/agenda", label: "Agenda", icon: "agenda", title: "Agenda — ranked tasks and outreach", status: "production" },
    { href: "/mail", label: "Mail", icon: "mail", status: "production" },
    { href: "/notes", label: "Notes", icon: "notes", status: "production" },
  ]},
  { section: "Operate", items: [
    { href: "/tasks", label: "Tasks", icon: "tasks", title: "Tasks — the assistant's durable work queue", status: "beta", statusReason: "New agent-Task workbench from the Axis System Redesign; backed by agent_tasks with server-enforced lifecycle transitions.", statusAction: "Validate create, status transitions, activity log, and empty/error/signed-out states before promotion." },
    { href: "/approvals", label: "Approvals", icon: "approvals", title: "Approvals — review and authorize gated actions", status: "beta", statusReason: "New approval queue from the Axis System Redesign; every gated action shows full scope (§11.3) and financial execution requires step-up. Empty until routines/agents create approvals.", statusAction: "Validate approve/deny/execute, step-up gating, expiry, and empty/error/signed-out states before promotion." },
    { href: "/memory", label: "Memory", icon: "memory", title: "Memory — inspect retained context and financial constraints", status: "beta", statusReason: "Structured user-controlled memory and the Financial Operating Profile are new redesign surfaces. Memory is context only and cannot authorize execution.", statusAction: "Validate profile confirmation, memory edit/archive/restore, expiry, and owner isolation before promotion." },
  ]},
  { section: "Plan", items: [
    { href: "/objectives", label: "Objectives", icon: "goals", status: "production", title: "Objectives — goals and key results" },
    { href: "/debrief", label: "Debrief", icon: "review", status: "production", title: "Debrief — weekly reflection and AI summary" },
  ]},
  { section: "Research", items: [
    { href: "/pipeline", label: "Pipeline", icon: "pipeline", status: "production", title: "Pipeline — studies and conferences" },
    { href: "/literature", label: "Literature", icon: "literature", status: "production", title: "Literature — research feed and saved papers" },
  ]},
  { section: "Life", items: [
    { href: "/people", label: "People", icon: "people", status: "production", title: "People — CRM and follow-ups" },
    { href: "/briefing", label: "Briefing", icon: "briefing", status: "production", title: "Briefing — curated stories and RSS feeds" },
  ]},
  { section: "Capital", items: [
    { href: "/fund", label: "Fund", icon: "chart", title: "Fund — portfolio and cash flow", status: "production" },
  ]},
  { section: "Labs", items: [
    { href: "/vitality", label: "Vitality", icon: "fitness", title: "Vitality — training and nutrition", status: "lab", statusReason: "Training, nutrition, and health-device areas mix live Strava with local-only and coming-soon flows.", statusAction: "Keep wearable metrics and manual logs labelled lab until Supabase-backed persistence is complete." },
    { href: "/atelier", label: "Atelier", icon: "atelier", status: "lab", statusReason: "Creative discovery remains exploratory and provider-dependent.", statusAction: "Validate source availability, pin persistence, and empty/error states before promotion." },
    { href: "/listening-vault", label: "Listening Vault", icon: "vault", title: "Listening Vault — music room", status: "lab", statusReason: "Music-room workflows depend on Spotify availability and exploratory listening UI.", statusAction: "Validate connect/disconnect, playback fallbacks, and saved state before promotion." },
    { href: "/library", label: "Library", icon: "library", status: "lab", statusReason: "Uploads are available, but the broader library workflow still needs production hardening.", statusAction: "Validate upload/delete/download, storage errors, and RLS before promotion." },
    { href: "/supper-club", label: "Supper Club", icon: "recipes", status: "lab", statusReason: "Recipe curation syncs to Supabase when signed in; seed catalog remains curated.", statusAction: "Validate recipe save, diet prefs persistence, and error states before promotion." },
  ]},
  { section: "System", items: [
    { href: "/control-room", label: "Control Room", icon: "system", title: "Control Room — settings and integrations", status: "production" },
  ]},
];

export const ALL_NAV_ITEMS: (NavItem & { section: string })[] = DEFAULT_NAV.flatMap((g) =>
  g.items.map((item) => ({ ...item, section: g.section })),
);
