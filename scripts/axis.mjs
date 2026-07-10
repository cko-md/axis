#!/usr/bin/env node
/**
 * AXIS agent-friendly CLI — non-interactive first, layered --help with examples.
 * Usage: node scripts/axis.mjs <command> [options]
 *        npm run axis -- <command> [options]
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAV_PATH = join(ROOT, "src/lib/store/nav.ts");

const HELP = {
  root: `AXIS CLI — agent-friendly project operations

Usage:
  node scripts/axis.mjs <command> [options]
  npm run axis -- <command> [options]

Commands:
  check       Run quality gates (tsc, lint, test)
  module      Module inventory and validation hints
  dev         Local dev server helpers
  supabase    Local Supabase stack status
  help        Show help for a command

Global options:
  --json      Machine-readable output where supported
  --yes       Skip confirmation prompts (destructive ops)
  --dry-run   Preview without side effects

Examples:
  node scripts/axis.mjs check
  node scripts/axis.mjs check --skip-e2e
  node scripts/axis.mjs module list --status beta
  node scripts/axis.mjs module validate literature --json
  node scripts/axis.mjs dev status
  node scripts/axis.mjs supabase status
  node scripts/axis.mjs help check
`,
  check: `axis check — run PR quality gates

Options:
  --skip-lint     Skip eslint
  --skip-test     Skip vitest
  --skip-tsc      Skip TypeScript check
  --skip-build    Skip next build (slow; off by default)

Examples:
  node scripts/axis.mjs check
  node scripts/axis.mjs check --skip-build
  node scripts/axis.mjs check --json
`,
  module: `axis module — module inventory and validation

Subcommands:
  list      List modules with status tags
  validate  Print validation checklist for a module slug

Options (list):
  --status <production|beta|lab|soon>   Filter by nav status
  --json                                JSON array output

Options (validate):
  --json                                JSON object output

Examples:
  node scripts/axis.mjs module list
  node scripts/axis.mjs module list --status beta --json
  node scripts/axis.mjs module validate command
  node scripts/axis.mjs module validate people --json
`,
  dev: `axis dev — local development helpers

Subcommands:
  status    Check if dev server responds on 127.0.0.1:3000

Examples:
  node scripts/axis.mjs dev status
  node scripts/axis.mjs dev status --json
`,
  supabase: `axis supabase — local Supabase CLI stack

Subcommands:
  status    Probe local API (127.0.0.1:54321)

Examples:
  node scripts/axis.mjs supabase status
  node scripts/axis.mjs supabase status --json
`,
};

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      flags.set("help", true);
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return {
    positional,
    flags,
    get(name) { return flags.get(name); },
    has(name) { return flags.has(name); },
  };
}

function fail(message, example) {
  console.error(`Error: ${message}`);
  if (example) console.error(example);
  process.exit(1);
}

function run(cmd, cmdArgs, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd, stdio: "inherit", shell: false });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, durationMs: Date.now() - started });
    });
  });
}

function parseNavModules() {
  if (!existsSync(NAV_PATH)) return [];
  const src = readFileSync(NAV_PATH, "utf8");
  const items = [];
  const re = /href:\s*"([^"]+)"[^}]*label:\s*"([^"]+)"[^}]*status:\s*"([^"]+)"(?:[^}]*statusReason:\s*"([^"]*)")?(?:[^}]*statusAction:\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    items.push({
      href: m[1],
      slug: m[1].replace(/^\//, "").replace(/\//g, "-") || "root",
      label: m[2],
      status: m[3],
      statusReason: m[4] ?? "",
      statusAction: m[5] ?? "",
    });
  }
  return items;
}

const MODULE_CHECKS = {
  command: [
    "Widgets render live data with loading/error/disconnected states",
    "Freeform block drag updates layout (order + column placement)",
    "Agenda widget shows tasks + schedule_events for today",
    "Hero typography respects Interface Studio display face",
  ],
  schedule: [
    "Google/Outlook external calendar fetch returns events or visible error",
    "Manual schedule_events CRUD persists via Supabase",
    "Week navigation refetches /api/calendar/external",
  ],
  literature: [
    "Saved articles persist to Supabase literature_saved (not localStorage-only)",
    "Top banner shows interactive stats and quick actions",
    "Live source search surfaces errors on provider failure",
  ],
  people: [
    "CRM add/edit/delete persists",
    "Google Contacts load or show actionable error (not silent fail)",
    "Contact import matching shows feedback",
  ],
  fund: [
    "Unconfigured Plaid/broker states visible",
    "Portfolio CRUD persists; quote failures show inline error",
    "Interactive fund banner with connection status",
  ],
  objectives: [
    "Create/edit/progress flows persist to Supabase",
    "Error states visible on save failure",
  ],
  debrief: [
    "Reflection save persists",
    "AI summary fallback when provider unavailable",
    "Reminder settings persist across reload",
  ],
  briefing: [
    "Feed add/remove persists",
    "On-demand refresh with failure toast",
    "Saved items persist",
  ],
  vitality: [
    "Strava connect/disconnect with clear error",
    "Interactive vitality banner",
  ],
  "listening-vault": [
    "Spotify auth connect flow completes or shows structured error",
    "No broken YouTube lounge if API unavailable",
  ],
  "supper-club": [
    "Saved recipes + diet prefs in Supabase",
    "Weekly/on-demand recipe refresh",
  ],
};

async function cmdCheck(flags) {
  const steps = [];
  if (!flags.has("skip-tsc")) steps.push({ name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] });
  if (!flags.has("skip-lint")) steps.push({ name: "lint", cmd: "npm", args: ["run", "lint"] });
  if (!flags.has("skip-test")) steps.push({ name: "test", cmd: "npm", args: ["run", "test"] });
  if (!flags.has("skip-build") && process.env.AXIS_CHECK_BUILD === "1") {
    steps.push({ name: "build", cmd: "npm", args: ["run", "build"] });
  }

  const results = [];
  for (const step of steps) {
    const r = await run(step.cmd, step.args);
    results.push({ step: step.name, ok: r.code === 0, durationMs: r.durationMs });
    if (r.code !== 0) {
      if (flags.has("json")) {
        console.log(JSON.stringify({ ok: false, results }, null, 2));
      } else {
        console.error(`check failed at step: ${step.name} (exit ${r.code})`);
        console.error("  node scripts/axis.mjs check --help");
      }
      process.exit(r.code);
    }
  }

  if (flags.has("json")) {
    console.log(JSON.stringify({ ok: true, results }, null, 2));
  } else {
    console.log("check: passed");
    for (const r of results) console.log(`  ${r.step}: ok (${Math.round(r.durationMs / 1000)}s)`);
  }
}

function cmdModuleList(flags) {
  const statusFilter = flags.get("status");
  let modules = parseNavModules();
  if (statusFilter) {
    const valid = ["production", "beta", "lab", "soon"];
    if (!valid.includes(statusFilter)) {
      fail(`Unknown status "${statusFilter}"`, `  node scripts/axis.mjs module list --status beta`);
    }
    modules = modules.filter((m) => m.status === statusFilter);
  }
  if (flags.has("json")) {
    console.log(JSON.stringify(modules, null, 2));
    return;
  }
  for (const m of modules) {
    console.log(`${m.status.padEnd(10)} ${m.label.padEnd(16)} ${m.href}`);
  }
  console.log(`\ncount: ${modules.length}`);
}

function cmdModuleValidate(slug, flags) {
  if (!slug) fail("Module slug required", "  node scripts/axis.mjs module validate literature");
  const modules = parseNavModules();
  const mod = modules.find((m) => m.slug === slug || m.href === `/${slug}`);
  const checks = MODULE_CHECKS[slug] ?? [
    "Happy path works end-to-end",
    "Error state visible on failure",
    "Data persists after reload (Supabase, not silent localStorage)",
  ];
  const payload = {
    slug,
    module: mod ?? null,
    checks,
    manualTestRequired: true,
  };
  if (flags.has("json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`validate: ${slug}`);
  if (mod) {
    console.log(`status: ${mod.status}`);
    if (mod.statusAction) console.log(`action: ${mod.statusAction}`);
  }
  console.log("checklist:");
  checks.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function cmdDevStatus(flags) {
  const url = "http://127.0.0.1:3000";
  const r = await probeUrl(url);
  const payload = { service: "next-dev", url, ...r };
  if (flags.has("json")) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (r.ok) console.log(`dev: up ${url} (${r.status})`);
  else console.error(`dev: down ${url}${r.error ? ` — ${r.error}` : ""}`);
  if (!r.ok) console.error("  npm run dev -- --hostname 127.0.0.1");
  process.exit(r.ok ? 0 : 1);
}

async function cmdSupabaseStatus(flags) {
  const url = "http://127.0.0.1:54321/rest/v1/";
  const r = await probeUrl(url);
  const payload = { service: "supabase-api", url, ...r };
  if (flags.has("json")) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (r.ok) console.log(`supabase: up ${url}`);
  else console.error(`supabase: down — ${r.error ?? `HTTP ${r.status}`}`);
  if (!r.ok) console.error("  See AGENTS.md Cursor Cloud Supabase startup steps");
  process.exit(r.ok ? 0 : 1);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = positional;

  if (!cmd || flags.has("help")) {
    const topic = cmd && HELP[cmd] ? cmd : "root";
    console.log(HELP[topic] ?? HELP.root);
    return;
  }

  if (cmd === "help") {
    const topic = sub ?? "root";
    if (!HELP[topic]) fail(`Unknown help topic "${topic}"`, "  node scripts/axis.mjs help");
    console.log(HELP[topic]);
    return;
  }

  if (cmd === "check") return cmdCheck(flags);
  if (cmd === "module") {
    if (sub === "list") return cmdModuleList(flags);
    if (sub === "validate") return cmdModuleValidate(rest[0], flags);
    fail("Unknown module subcommand", "  node scripts/axis.mjs module list --help");
  }
  if (cmd === "dev") {
    if (sub === "status") return cmdDevStatus(flags);
    fail("Unknown dev subcommand", "  node scripts/axis.mjs dev status");
  }
  if (cmd === "supabase") {
    if (sub === "status") return cmdSupabaseStatus(flags);
    fail("Unknown supabase subcommand", "  node scripts/axis.mjs supabase status");
  }

  fail(`Unknown command "${cmd}"`, "  node scripts/axis.mjs --help");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
