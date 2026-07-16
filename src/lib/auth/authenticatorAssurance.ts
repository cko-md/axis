export type AuthenticatorAssuranceState =
  | "satisfied"
  | "mfa_required"
  | "unavailable";

type AssuranceResponse = {
  data: {
    currentLevel: string | null;
    nextLevel: string | null;
  } | null;
  error: unknown;
};

type AssuranceClient = {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: () => Promise<AssuranceResponse>;
    };
  };
};

const MFA_BOOTSTRAP_API_PATHS = new Set([
  "/api/auth/mfa/challenge",
  "/api/auth/mfa/verify",
]);

export function isMfaBootstrapApiPath(pathname: string): boolean {
  return MFA_BOOTSTRAP_API_PATHS.has(pathname);
}

export async function requireAuthenticatorAssurance(
  client: AssuranceClient,
): Promise<AuthenticatorAssuranceState> {
  try {
    const { data, error } =
      await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return "unavailable";

    if (data.currentLevel === "aal2") return "satisfied";
    if (data.currentLevel !== "aal1") return "unavailable";
    if (data.nextLevel === "aal2") return "mfa_required";
    if (data.nextLevel === "aal1") return "satisfied";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
