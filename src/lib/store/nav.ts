export type NavItem = {
  href: string;
  label: string;
  icon: string;
  title?: string;
  ix?: string;
};

export type NavGroup = { section: string; items: NavItem[] };

export const DEFAULT_NAV: NavGroup[] = [
  { section: "Daily", items: [
    { href: "/console", label: "Console", icon: "console" },
    { href: "/signals", label: "Signals", icon: "signals", title: "Signals — triage incoming items" },
    { href: "/schedule", label: "Schedule", icon: "calendar", title: "Schedule — week, month, day views" },
    { href: "/agenda", label: "Agenda", icon: "agenda", title: "Agenda — ranked tasks and outreach" },
    { href: "/mail", label: "Mail", icon: "mail" },
    { href: "/notes", label: "Notes", icon: "notes" },
  ]},
  { section: "Plan", items: [
    { href: "/objectives", label: "Objectives", icon: "goals" },
    { href: "/debrief", label: "Debrief", icon: "review" },
  ]},
  { section: "Research", items: [
    { href: "/pipeline", label: "Pipeline", icon: "pipeline" },
    { href: "/literature", label: "Literature", icon: "literature" },
  ]},
  { section: "Life", items: [
    { href: "/vitality", label: "Vitality", icon: "fitness", title: "Vitality — training and nutrition" },
    { href: "/atelier", label: "Atelier", icon: "atelier" },
    { href: "/gallery", label: "Gallery", icon: "gallery", title: "Gallery — art, poetry, and reading" },
    { href: "/people", label: "People", icon: "people" },
    { href: "/briefing", label: "Briefing", icon: "briefing" },
    { href: "/listening-vault", label: "Listening Vault", icon: "vault", title: "Listening Vault — music room" },
    { href: "/library", label: "Library", icon: "library" },
    { href: "/supper-club", label: "Supper Club", icon: "recipes" },
  ]},
  { section: "Capital", items: [
    { href: "/fund", label: "Fund", icon: "chart", title: "Fund — portfolio and cash flow" },
  ]},
  { section: "System", items: [
    { href: "/control-room", label: "Control Room", icon: "system", title: "Control Room — settings and integrations" },
  ]},
];

export const ALL_NAV_ITEMS: (NavItem & { section: string })[] = DEFAULT_NAV.flatMap((g) =>
  g.items.map((item) => ({ ...item, section: g.section })),
);
