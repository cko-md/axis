import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expansionMigrations = [
  {
    version: "202607161300",
    file: "supabase/migrations/202607161300_task_approval_atomic.sql",
    markers: ["(expand phase)", "legacy browser-facing grants temporarily"],
  },
  {
    version: "202607161302",
    file: "supabase/migrations/202607161302_webauthn_atomic.sql",
    markers: ["Atomic WebAuthn ceremony consumption", "to service_role"],
  },
  {
    version: "202607161400",
    file: "supabase/migrations/202607161400_routine_resume_claims.sql",
    markers: ["(expand phase)", "legacy owner-scoped table policies"],
  },
];

const contractMigration = {
  version: "202607161401",
  file: "supabase/migrations/202607161401_task_approval_lockdown.sql",
  markers: [
    "(contract phase)",
    "Apply only after the application version",
    "revoke insert, update, delete on public.agent_tasks",
  ],
};

const verificationFiles = [
  "scripts/sql/verify-20260716-expand.sql",
  "scripts/sql/verify-20260716-contract.sql",
];

const releaseDoc = "docs/axis-redesign/12-release-plan.md";

function fail(message) {
  console.error(`release validation failed: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {
    stage: "plan",
    appLiveRevision: null,
    expansionsVerified: false,
    contractApproved: false,
    recoveryOwner: null,
  };

  for (const arg of argv) {
    if (arg.startsWith("--stage=")) {
      parsed.stage = arg.slice("--stage=".length);
    } else if (arg.startsWith("--app-live-revision=")) {
      parsed.appLiveRevision = arg.slice("--app-live-revision=".length);
    } else if (arg === "--expansions-verified") {
      parsed.expansionsVerified = true;
    } else if (arg === "--contract-approved") {
      parsed.contractApproved = true;
    } else if (arg.startsWith("--recovery-owner=")) {
      parsed.recoveryOwner = arg.slice("--recovery-owner=".length);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }

  if (!["plan", "expand", "contract"].includes(parsed.stage)) {
    fail(`unsupported stage ${parsed.stage}`);
  }

  return parsed;
}

function readRequired(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    fail(`missing required file ${path}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

function validateMigration(item) {
  const content = readRequired(item.file);
  if (!item.file.split("/").at(-1)?.startsWith(`${item.version}_`)) {
    fail(`${item.file} does not match declared version ${item.version}`);
  }
  for (const marker of item.markers) {
    if (!content.includes(marker)) {
      fail(`${item.file} is missing safety marker: ${marker}`);
    }
  }
  if (!/\bbegin;\s/i.test(content) || !/\bcommit;\s*$/i.test(content)) {
    fail(`${item.file} must remain transaction-wrapped`);
  }
  return { ...item, checksum: checksum(content) };
}

function workflowFiles() {
  const workflowDir = join(root, ".github", "workflows");
  return readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => join(workflowDir, name));
}

function validateSingleDeploymentOwner() {
  for (const file of workflowFiles()) {
    const content = readFileSync(file, "utf8");
    if (/\bvercel\s+(?:deploy\s+)?--prod\b/i.test(content)) {
      fail(
        `${relative(root, file)} contains a second production deploy; Vercel Git integration is the sole deploy owner`,
      );
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const expansions = expansionMigrations.map(validateMigration);
const contract = validateMigration(contractMigration);

const versions = [...expansions.map(({ version }) => version), contract.version];
if (new Set(versions).size !== versions.length) {
  fail("release migration versions must be unique");
}
if (versions.join(",") !== [...versions].sort().join(",")) {
  fail("release migrations are not in lexical execution order");
}
if (contract.version <= expansions.at(-1).version) {
  fail("contract migration must sort after every expansion migration");
}

for (const file of verificationFiles) readRequired(file);

const doc = readRequired(releaseDoc);
for (const { file } of [...expansions, contract]) {
  if (!doc.includes(file)) {
    fail(`${releaseDoc} does not name ${file}`);
  }
}
if (!doc.includes("NEVER apply the contract migration before")) {
  fail(`${releaseDoc} is missing the pre-deploy contract prohibition`);
}

validateSingleDeploymentOwner();

if (args.stage === "contract") {
  if (!args.expansionsVerified) {
    fail("contract preflight requires --expansions-verified");
  }
  if (!args.contractApproved) {
    fail("contract preflight requires --contract-approved");
  }
  if (!args.appLiveRevision || !/^[0-9a-f]{7,40}$/i.test(args.appLiveRevision)) {
    fail("contract preflight requires --app-live-revision=<deployed git sha>");
  }
  if (
    !args.recoveryOwner ||
    args.recoveryOwner.length > 100 ||
    /[\r\n]/.test(args.recoveryOwner)
  ) {
    fail("contract preflight requires --recovery-owner=<incident owner>");
  }
}

if (process.exitCode) process.exit();

console.log(`Release wave validation passed (stage: ${args.stage}).`);
console.log("Expansion order:");
for (const item of expansions) {
  console.log(`  ${item.version}  ${item.checksum}  ${item.file}`);
}
console.log("Application: merge to main; Vercel Git integration deploys exactly once.");
console.log(
  `Contract: ${contract.version}  ${contract.checksum}  ${contract.file}`,
);
console.log(`Expand read-back: ${verificationFiles[0]}`);
console.log(`Contract read-back: ${verificationFiles[1]}`);
if (args.stage === "contract") {
  console.log(
    `Contract authorization recorded for deployed revision ${args.appLiveRevision}; recovery owner ${args.recoveryOwner}.`,
  );
}
