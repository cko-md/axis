import { randomBytes } from "node:crypto";

export function createAuthenticatedE2ECredential(
  random = randomBytes,
) {
  const credential = random(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{40,}$/.test(credential)) {
    throw new Error("Authenticated E2E credential generation returned an invalid value.");
  }
  return credential;
}

export function writeAuthenticatedE2EEnvironment({
  outputPath,
  values,
  credential,
  isGitHubActions,
  emit,
  append,
}) {
  // GitHub processes this workflow command before it renders later log lines.
  // Keeping it ahead of the environment-file write prevents subsequent step
  // diagnostics from revealing the per-run credential.
  if (isGitHubActions) emit(`::add-mask::${credential}`);

  append(
    outputPath,
    [
      `NEXT_PUBLIC_SUPABASE_URL=${values.url}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${values.serviceRoleKey}`,
      `NEXT_PUBLIC_APP_URL=${values.appUrl}`,
      `E2E_USER_EMAIL=${values.email}`,
      `E2E_USER_PASSWORD=${credential}`,
      "AXIS_E2E_AUTH=1",
      "",
    ].join("\n"),
  );
}
