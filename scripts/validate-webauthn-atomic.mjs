import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

function outcome(result) {
  if (result.error) {
    throw new Error(`RPC failed: ${result.error.code ?? "unknown"}`);
  }
  return result.data;
}

if (!process.argv.includes("--local")) {
  throw new Error("Refusing to run without --local");
}

const localContainerValue = (name) => execFileSync(
  "docker",
  ["exec", "supabase_studio_axis", "printenv", name],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
const url = "http://127.0.0.1:54321";
const anonKey = localContainerValue("SUPABASE_ANON_KEY");
const serviceKey = localContainerValue("SUPABASE_SERVICE_KEY");
if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase URL, anon key, and service role key are required");
}
const hostname = new URL(url).hostname;
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  throw new Error(`Refusing non-local Supabase target: ${hostname}`);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const password = `Axis-${randomUUID()}-9a!`;
let userId = null;

try {
  const email = `axis-webauthn-${randomUUID()}@example.test`;
  const { data: createdUser, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createUserError || !createdUser.user) {
    throw new Error(`Local validation user creation failed: ${createUserError?.status ?? "unknown"}`);
  }
  userId = createdUser.user.id;

  const authenticated = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await authenticated.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    throw new Error(`Local validation sign-in failed: ${signInError.status ?? "unknown"}`);
  }

  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = linkData.properties?.hashed_token;
  if (linkError || !tokenHash) {
    throw new Error(`Local magic-link issuance failed: ${linkError?.status ?? "unknown"}`);
  }
  const cookieSession = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verifiedOtp, error: verifyOtpError } =
    await cookieSession.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
  check(
    !verifyOtpError && verifiedOtp.user?.id === userId && verifiedOtp.session?.user.id === userId,
    "server-only magic-link redemption issues a session for the expected owner",
  );

  const exactChallengeId = randomUUID();
  const { error: exactInsertError } = await admin
    .from("webauthn_challenges")
    .insert({
      id: exactChallengeId,
      challenge: randomUUID(),
      type: "registration",
      user_id: userId,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  if (exactInsertError) throw exactInsertError;

  const wrongId = outcome(await admin.rpc("consume_webauthn_challenge", {
    p_challenge_id: randomUUID(),
    p_type: "registration",
    p_user_id: userId,
    p_now: new Date().toISOString(),
  }));
  check(wrongId.outcome === "not_found", "a different challenge ID cannot consume the ceremony");

  const exactConsume = outcome(await admin.rpc("consume_webauthn_challenge", {
    p_challenge_id: exactChallengeId,
    p_type: "registration",
    p_user_id: userId,
    p_now: new Date().toISOString(),
  }));
  check(
    exactConsume.outcome === "consumed" && exactConsume.challengeId === exactChallengeId,
    "the exact challenge ID is consumed",
  );
  const replayConsume = outcome(await admin.rpc("consume_webauthn_challenge", {
    p_challenge_id: exactChallengeId,
    p_type: "registration",
    p_user_id: userId,
    p_now: new Date().toISOString(),
  }));
  check(replayConsume.outcome === "not_found", "a consumed challenge cannot replay");

  const racingChallengeId = randomUUID();
  const { error: racingInsertError } = await admin
    .from("webauthn_challenges")
    .insert({
      id: racingChallengeId,
      challenge: randomUUID(),
      type: "authentication",
      user_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  if (racingInsertError) throw racingInsertError;
  const consumeRace = await Promise.all([
    admin.rpc("consume_webauthn_challenge", {
      p_challenge_id: racingChallengeId,
      p_type: "authentication",
      p_user_id: null,
      p_now: new Date().toISOString(),
    }),
    admin.rpc("consume_webauthn_challenge", {
      p_challenge_id: racingChallengeId,
      p_type: "authentication",
      p_user_id: null,
      p_now: new Date().toISOString(),
    }),
  ]);
  const consumeOutcomes = consumeRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(consumeOutcomes) === JSON.stringify(["consumed", "not_found"]),
    "concurrent challenge consumption has exactly one winner",
  );

  const firstPasskey = outcome(await admin.rpc("create_user_passkey", {
    p_user_id: userId,
    p_credential_id: randomUUID(),
    p_credential_public_key: "validation-public-key",
    p_counter: 0,
    p_device_type: "platform",
    p_backed_up: false,
    p_transports: ["internal"],
    p_name: "Validation platform",
  }));
  check(firstPasskey.outcome === "created", "a verified passkey can be created atomically");

  const counterRace = await Promise.all([
    admin.rpc("commit_passkey_authentication", {
      p_user_id: userId,
      p_passkey_id: firstPasskey.passkeyId,
      p_expected_counter: 0,
      p_new_counter: 0,
      p_expected_last_used_at: null,
      p_used_at: new Date().toISOString(),
    }),
    admin.rpc("commit_passkey_authentication", {
      p_user_id: userId,
      p_passkey_id: firstPasskey.passkeyId,
      p_expected_counter: 0,
      p_new_counter: 0,
      p_expected_last_used_at: null,
      p_used_at: new Date().toISOString(),
    }),
  ]);
  const counterOutcomes = counterRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(counterOutcomes) === JSON.stringify(["counter_conflict", "updated"]),
    "concurrent zero-counter commits still have exactly one CAS winner",
  );

  const secondPasskey = outcome(await admin.rpc("create_user_passkey", {
    p_user_id: userId,
    p_credential_id: randomUUID(),
    p_credential_public_key: "validation-public-key-2",
    p_counter: 0,
    p_device_type: "cross-platform",
    p_backed_up: false,
    p_transports: ["usb"],
    p_name: "Validation security key",
  }));
  const deleteRace = await Promise.all([
    admin.rpc("delete_user_passkey", {
      p_user_id: userId,
      p_passkey_id: firstPasskey.passkeyId,
    }),
    admin.rpc("delete_user_passkey", {
      p_user_id: userId,
      p_passkey_id: secondPasskey.passkeyId,
    }),
  ]);
  check(
    deleteRace.map(outcome).every((value) => value.outcome === "deleted"),
    "concurrent passkey deletions both commit",
  );
  const { data: authSettings, error: settingsError } = await admin
    .from("user_auth_settings")
    .select("passkey_enabled")
    .eq("user_id", userId)
    .single();
  if (settingsError) throw settingsError;
  check(authSettings.passkey_enabled === false, "deleting the final passkey disables passkey settings");

  const directInsert = await authenticated.from("user_passkeys").insert({
    user_id: userId,
    credential_id: randomUUID(),
    credential_public_key: "forged",
    counter: 0,
    name: "forged",
  });
  check(Boolean(directInsert.error), "authenticated clients cannot directly insert passkeys");
  const directUpdate = await authenticated
    .from("user_passkeys")
    .update({ credential_public_key: "forged" })
    .eq("id", randomUUID());
  check(Boolean(directUpdate.error), "authenticated clients cannot directly update passkeys");
  const directDelete = await authenticated
    .from("user_passkeys")
    .delete()
    .eq("id", randomUUID());
  check(Boolean(directDelete.error), "authenticated clients cannot directly delete passkeys");

  const directRpcChecks = await Promise.all([
    authenticated.rpc("consume_webauthn_challenge", {
      p_challenge_id: randomUUID(),
      p_type: "authentication",
      p_user_id: null,
      p_now: new Date().toISOString(),
    }),
    authenticated.rpc("create_user_passkey", {
      p_user_id: userId,
      p_credential_id: randomUUID(),
      p_credential_public_key: "forged",
      p_counter: 0,
      p_device_type: "platform",
      p_backed_up: false,
      p_transports: ["internal"],
      p_name: "forged",
    }),
    authenticated.rpc("commit_passkey_authentication", {
      p_user_id: userId,
      p_passkey_id: randomUUID(),
      p_expected_counter: 0,
      p_new_counter: 1,
      p_expected_last_used_at: null,
      p_used_at: new Date().toISOString(),
    }),
    authenticated.rpc("delete_user_passkey", {
      p_user_id: userId,
      p_passkey_id: randomUUID(),
    }),
  ]);
  check(
    directRpcChecks.every((result) => Boolean(result.error)),
    "authenticated clients cannot execute service-only WebAuthn RPCs",
  );

  console.log("WebAuthn atomic validation complete");
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId);
}
