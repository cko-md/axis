import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  createAuthenticatedE2ECredential,
  writeAuthenticatedE2EEnvironment,
} from "./authenticated-e2e-credentials.mjs";

function localSupabaseEnv() {
  const cli = process.env.SUPABASE_CLI_PATH ?? "supabase";
  const output = execFileSync(cli, ["status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

function assertLocalUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:") {
    throw new Error("Authenticated E2E bootstrap requires a local HTTP Supabase URL.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Refusing to create an E2E user outside local Supabase.");
  }
  return url.toString().replace(/\/$/, "");
}

async function findUserByEmail(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) {
      throw new Error(`Local E2E user lookup failed (${error.status ?? "unknown"}).`);
    }
    const match = data.users.find((user) => user.email === email);
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  throw new Error("Local E2E user lookup exceeded its bounded page limit.");
}

const outputPath = process.argv[2] ?? process.env.GITHUB_ENV;
if (!outputPath) {
  throw new Error("Pass an environment-file path or set GITHUB_ENV.");
}

const discovered = localSupabaseEnv();
const url = assertLocalUrl(discovered.API_URL);
const anonKey = discovered.ANON_KEY;
const serviceRoleKey = discovered.SERVICE_ROLE_KEY;
if (!anonKey || !serviceRoleKey) {
  throw new Error("Local Supabase did not expose anon and service-role keys.");
}

const email = process.env.E2E_USER_EMAIL ?? "axis-ci-auth@example.test";
// A CI run needs a credential only long enough to establish its isolated local
// Supabase session. Generate it per run and mask it before it enters GITHUB_ENV
// so GitHub never prints it in later step environment diagnostics.
const password = process.env.E2E_USER_PASSWORD ?? createAuthenticatedE2ECredential();
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const existing = await findUserByEmail(admin, email);
if (existing) {
  const { error } = await admin.auth.admin.deleteUser(existing.id);
  if (error) {
    throw new Error(`Local E2E user reset failed (${error.status ?? "unknown"}).`);
  }
}

const { error: createError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createError) {
  throw new Error(`Local E2E user creation failed (${createError.status ?? "unknown"}).`);
}

const appUrl = "http://127.0.0.1:3000";
writeAuthenticatedE2EEnvironment({
  outputPath,
  values: {
    url,
    anonKey,
    serviceRoleKey,
    appUrl,
    email,
  },
  credential: password,
  isGitHubActions: process.env.GITHUB_ACTIONS === "true",
  emit: (line) => console.log(line),
  append: (path, contents) => appendFileSync(path, contents, {
    encoding: "utf8",
    mode: 0o600,
  }),
});

console.log("Prepared one confirmed user in local Supabase for authenticated E2E.");
