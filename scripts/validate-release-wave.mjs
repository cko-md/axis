import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectMigrationEntries,
  findMutableGitHubActionReferences,
  findSecondaryVercelProductionDeploys,
  loadProtectedMigrationBaseline,
  readMigrationManifest,
  validateAppendOnlyMigrationManifest,
  validateReleaseGovernanceWorkflow,
  validateMigrationManifest,
  validateTrustedYamlParser,
} from "./release-validation-core.mjs";

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
  "scripts/sql/verify-provider-mutations-expand.sql",
  "scripts/sql/verify-provider-mutations.sql",
];

const releaseDoc = "docs/axis-redesign/12-release-plan.md";
const migrationManifest = "scripts/release-migration-manifest.json";

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
  return item;
}

function validateSingleDeploymentOwner() {
  let packageScripts = {};
  try {
    packageScripts = JSON.parse(readRequired("package.json")).scripts ?? {};
  } catch {
    fail("package.json must be valid JSON to verify deployment ownership");
  }
  for (const file of findSecondaryVercelProductionDeploys(
    join(root, ".github", "workflows"),
    { packageScripts },
  )) {
    fail(
      `${relative(root, join(root, ".github", "workflows", file))} contains a second production deploy; Vercel Git integration is the sole deploy owner`,
    );
  }
}

function validateGitHubActionPins() {
  for (const reference of findMutableGitHubActionReferences(
    join(root, ".github", "workflows"),
  )) {
    fail(
      `${relative(root, join(root, ".github", "workflows"))}/${reference} uses a mutable GitHub Action ref; pin it to a full commit SHA with a readable version comment`,
    );
  }
}

function validateTrustedReleaseGovernance() {
  for (const error of validateReleaseGovernanceWorkflow(
    readRequired(".github/workflows/release-governance.yml"),
  )) {
    fail(error);
  }
  for (const error of validateTrustedYamlParser(root)) {
    fail(error);
  }
}

const args = parseArgs(process.argv.slice(2));
let manifest;
let actualMigrations;
try {
  manifest = readMigrationManifest(join(root, migrationManifest));
  actualMigrations = collectMigrationEntries(join(root, "supabase", "migrations"));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}
const manifestErrors = validateMigrationManifest(
  manifest,
  actualMigrations,
);
for (const error of manifestErrors) fail(error);
try {
  const baseline = loadProtectedMigrationBaseline(root);
  for (const error of validateAppendOnlyMigrationManifest(baseline.manifest, manifest)) {
    fail(`${error} (protected baseline ${baseline.revision} via ${baseline.source})`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
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
validateGitHubActionPins();
validateTrustedReleaseGovernance();

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
console.log(
  `Committed migration manifest: ${manifest.migrationCount} migrations; latest ${manifest.latest.version}  ${manifest.latest.sha256}  ${manifest.latest.file}`,
);
console.log("Migrations (lexical filename order):");
for (const item of manifest.migrations) {
  console.log(`  ${item.version}  ${item.sha256}  ${item.file}`);
}
console.log(
  "Application: source merge is production-skipped; the protected canonical-state refresh is the sole production build.",
);
console.log("Historical lifecycle safety checks:");
console.log(`  Expansion order: ${expansions.map(({ version }) => version).join(", ")}`);
console.log(`  Contract: ${contract.version}  ${contract.file}`);
console.log(`Expand read-back: ${verificationFiles[0]}`);
console.log(`Contract read-back: ${verificationFiles[1]}`);
console.log(`Provider mutation expansion read-back: ${verificationFiles[2]}`);
console.log(`Provider mutation contract read-back: ${verificationFiles[3]}`);
if (args.stage === "contract") {
  console.log(
    `Contract authorization recorded for deployed revision ${args.appLiveRevision}; recovery owner ${args.recoveryOwner}.`,
  );
}
