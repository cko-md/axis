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
  { section: "Plan", items: [
    { href: "/objectives", label: "Objectives", icon: "goals", status: "beta", statusReason: "Goal tracking is usable, but promotion depends on deeper review, error, and persistence validation.", statusAction: "Validate create/edit/progress/persist flows before treating it as production." },
    { href: "/debrief", label: "Debrief", icon: "review", status: "beta", statusReason: "Reflection capture is usable, but reminder and AI summary flows still need production validation.", statusAction: "Confirm save, summary fallback, reminder persistence, and retry behavior." },
  ]},
  { section: "Research", items: [
    { href: "/pipeline", label: "Pipeline", icon: "pipeline", status: "beta", statusReason: "Study and conference tracking persists, but the full research workflow still needs end-to-end hardening.", statusAction: "Validate board edits, detail actions, archive/delete, and refresh persistence." },
    { href: "/literature", label: "Literature", icon: "literature", status: "beta", statusReason: "Live source search works, but saved articles and custom topics still include local-only beta persistence.", statusAction: "Treat saved/offline reading as device-local until a Supabase-backed slice is promoted." },
  ]},
  { section: "Life", items: [
    { href: "/people", label: "People", icon: "people", status: "beta", statusReason: "CRM records persist, but contacts matching and provider parity still need production validation.", statusAction: "Validate add/edit/delete, contact import, matching feedback, and empty/error states." },
    { href: "/briefing", label: "Briefing", icon: "briefing", status: "beta", statusReason: "Feed reading is usable, but source discovery and saved-item behavior still need deeper hardening.", statusAction: "Validate feed add/remove, refresh failure, saved items, and provider outages." },
  ]},
  { section: "Capital", items: [
    { href: "/fund", label: "Fund", icon: "chart", title: "Fund — portfolio and cash flow", status: "beta", statusReason: "Portfolio and cash-flow tools rely on multiple financial providers and partial broker/Plaid coverage.", statusAction: "Validate configured/unconfigured states, CRUD persistence, quote failures, and non-execution messaging." },
  ]},
  { section: "Labs", items: [
    { href: "/vitality", label: "Vitality", icon: "fitness", title: "Vitality — training and nutrition", status: "lab", statusReason: "Training, nutrition, and health-device areas mix live Strava with local-only and coming-soon flows.", statusAction: "Keep wearable metrics and manual logs labelled lab until Supabase-backed persistence is complete." },
    { href: "/atelier", label: "Atelier", icon: "atelier", status: "lab", statusReason: "Creative discovery remains exploratory and provider-dependent.", statusAction: "Validate source availability, pin persistence, and empty/error states before promotion." },
    { href: "/listening-vault", label: "Listening Vault", icon: "vault", title: "Listening Vault — music room", status: "lab", statusReason: "Music-room workflows depend on Spotify availability and exploratory listening UI.", statusAction: "Validate connect/disconnect, playback fallbacks, and saved state before promotion." },
    { href: "/library", label: "Library", icon: "library", status: "lab", statusReason: "Uploads are available, but the broader library workflow still needs production hardening.", statusAction: "Validate upload/delete/download, storage errors, and RLS before promotion." },
    { href: "/supper-club", label: "Supper Club", icon: "recipes", status: "lab", statusReason: "Recipe curation is intentionally local-only and exploratory.", statusAction: "Saved recipes and diet preferences stay on this device until a Supabase recipe slice ships." },
  ]},
  { section: "System", items: [
    { href: "/control-room", label: "Control Room", icon: "system", title: "Control Room — settings and integrations", status: "production" },
  ]},
];

export const ALL_NAV_ITEMS: (NavItem & { section: string })[] = DEFAULT_NAV.flatMap((g) =>
  g.items.map((item) => ({ ...item, section: g.section })),
);
