export type NavItem = {
  href: string;
  label: string;
  icon: string;
  title?: string;
  ix?: string;
  status?: "production" | "beta" | "lab" | "soon";
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
    { href: "/objectives", label: "Objectives", icon: "goals", status: "beta" },
    { href: "/debrief", label: "Debrief", icon: "review", status: "beta" },
  ]},
  { section: "Research", items: [
    { href: "/pipeline", label: "Pipeline", icon: "pipeline", status: "beta" },
    { href: "/literature", label: "Literature", icon: "literature", status: "beta" },
  ]},
  { section: "Life", items: [
    { href: "/people", label: "People", icon: "people", status: "beta" },
    { href: "/briefing", label: "Briefing", icon: "briefing", status: "beta" },
  ]},
  { section: "Capital", items: [
    { href: "/fund", label: "Fund", icon: "chart", title: "Fund — portfolio and cash flow", status: "beta" },
  ]},
  { section: "Labs", items: [
    { href: "/vitality", label: "Vitality", icon: "fitness", title: "Vitality — training and nutrition", status: "lab" },
    { href: "/atelier", label: "Atelier", icon: "atelier", status: "lab" },
    { href: "/listening-vault", label: "Listening Vault", icon: "vault", title: "Listening Vault — music room", status: "lab" },
    { href: "/library", label: "Library", icon: "library", status: "lab" },
    { href: "/supper-club", label: "Supper Club", icon: "recipes", status: "lab" },
  ]},
  { section: "System", items: [
    { href: "/control-room", label: "Control Room", icon: "system", title: "Control Room — settings and integrations", status: "production" },
  ]},
];

export const ALL_NAV_ITEMS: (NavItem & { section: string })[] = DEFAULT_NAV.flatMap((g) =>
  g.items.map((item) => ({ ...item, section: g.section })),
);
