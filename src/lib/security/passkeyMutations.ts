import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = SupabaseClient;

export type PasskeyChallengeType = "registration" | "authentication";

export type PasskeyChallengeConsumeResult =
  | { ok: true; challengeId: string; challenge: string }
  | {
      ok: false;
      code: "SERVICE_UNAVAILABLE" | "RPC_FAILED" | "INVALID_RESPONSE" | "NOT_FOUND";
    };

export type PasskeyRegistrationResult =
  | { ok: true; passkeyId: string }
  | {
      ok: false;
      code:
        | "SERVICE_UNAVAILABLE"
        | "RPC_FAILED"
        | "INVALID_RESPONSE"
        | "CREDENTIAL_EXISTS";
    };

export type PasskeyAuthenticationCommitResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "SERVICE_UNAVAILABLE"
        | "RPC_FAILED"
        | "INVALID_RESPONSE"
        | "PASSKEY_NOT_FOUND"
        | "COUNTER_CONFLICT";
    };

export type PasskeyDeleteResult =
  | { ok: true; hasPasskeys: boolean }
  | {
      ok: false;
      code: "SERVICE_UNAVAILABLE" | "RPC_FAILED" | "INVALID_RESPONSE" | "NOT_FOUND";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeAuthenticatorAttachment(
  value: unknown,
): "platform" | "cross-platform" | null {
  return value === "platform" || value === "cross-platform" ? value : null;
}

export async function consumeWebAuthnChallenge(
  input: {
    challengeId: string;
    type: PasskeyChallengeType;
    userId: string | null;
    now: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<PasskeyChallengeConsumeResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };

  const { data, error } = await client.rpc("consume_webauthn_challenge", {
    p_challenge_id: input.challengeId,
    p_type: input.type,
    p_user_id: input.userId,
    p_now: input.now,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };

  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (
    result.outcome === "consumed"
    && typeof result.challengeId === "string"
    && typeof result.challenge === "string"
  ) {
    return {
      ok: true,
      challengeId: result.challengeId,
      challenge: result.challenge,
    };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function createUserPasskey(
  input: {
    userId: string;
    credentialId: string;
    credentialPublicKey: string;
    counter: number;
    deviceType: "platform" | "cross-platform" | null;
    backedUp: boolean;
    transports: string[];
    name: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<PasskeyRegistrationResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };

  const { data, error } = await client.rpc("create_user_passkey", {
    p_user_id: input.userId,
    p_credential_id: input.credentialId,
    p_credential_public_key: input.credentialPublicKey,
    p_counter: input.counter,
    p_device_type: input.deviceType,
    p_backed_up: input.backedUp,
    p_transports: input.transports,
    p_name: input.name,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };

  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "credential_exists") {
    return { ok: false, code: "CREDENTIAL_EXISTS" };
  }
  if (result.outcome === "created" && typeof result.passkeyId === "string") {
    return { ok: true, passkeyId: result.passkeyId };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function commitPasskeyAuthentication(
  input: {
    userId: string;
    passkeyId: string;
    expectedCounter: number;
    newCounter: number;
    expectedLastUsedAt: string | null;
    usedAt: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<PasskeyAuthenticationCommitResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };

  const { data, error } = await client.rpc("commit_passkey_authentication", {
    p_user_id: input.userId,
    p_passkey_id: input.passkeyId,
    p_expected_counter: input.expectedCounter,
    p_new_counter: input.newCounter,
    p_expected_last_used_at: input.expectedLastUsedAt,
    p_used_at: input.usedAt,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };

  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "updated") return { ok: true };
  if (result.outcome === "passkey_not_found") {
    return { ok: false, code: "PASSKEY_NOT_FOUND" };
  }
  if (result.outcome === "counter_conflict") {
    return { ok: false, code: "COUNTER_CONFLICT" };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function deleteUserPasskey(
  input: {
    userId: string;
    passkeyId: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<PasskeyDeleteResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };

  const { data, error } = await client.rpc("delete_user_passkey", {
    p_user_id: input.userId,
    p_passkey_id: input.passkeyId,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };

  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (result.outcome === "deleted" && typeof result.hasPasskeys === "boolean") {
    return { ok: true, hasPasskeys: result.hasPasskeys };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}
