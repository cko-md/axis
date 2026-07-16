import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

function outcome(result) {
  if (result.error) throw new Error(`RPC failed: ${result.error.code ?? "unknown"}`);
  return result.data;
}

function localSupabaseEnv() {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], {
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

const useLocal = process.argv.includes("--local");
if (!useLocal) loadEnv(".env.local");
const discovered = useLocal ? localSupabaseEnv() : {};
const url = useLocal ? discovered.API_URL : process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = useLocal ? discovered.ANON_KEY : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = useLocal ? discovered.SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase URL, anon key, and service role key are required");
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const run = randomUUID();
const password = `Axis-${randomUUID()}-9a!`;
const users = [];

async function authenticated(email) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Local validation sign-in failed: ${error.status ?? "unknown"}`);
  return client;
}

async function createTask(userId, label) {
  return outcome(await admin.rpc("create_agent_task_with_activity", {
    p_user_id: userId,
    p_objective: `CAS validation ${run} ${label}`,
    p_context: { validation: true },
    p_source_routine_id: null,
    p_source_skill: "validation",
    p_activity_detail: { validation: true },
  })).task;
}

async function createApproval(userId, taskId, label, overrides = {}) {
  const proposed = {
    actor: { kind: "agent", id: "axis-validation" },
    tool: "axis.update_record",
    summary: `CAS validation ${label}`,
    target: { entityType: "record", entityId: randomUUID() },
  };
  return outcome(await admin.rpc("create_approval_with_activity", {
    p_user_id: userId,
    p_task_id: taskId,
    p_action_class: "INTERNAL_WRITE",
    p_requirement: "approval",
    p_reasons: ["INTERNAL_WRITE requires approval."],
    p_proposed_action: proposed,
    p_scope: "one_time",
    p_expires_at: null,
    ...overrides,
  })).approval;
}

function financialScope(overrides = {}) {
  const base = {
    actor: { kind: "agent", id: "axis-validation" },
    tool: "public.place_order",
    summary: "Place validation order",
    target: { entityType: "order", accountId: "validation-account" },
    amount: { value: 100, currency: "USD", quantity: 1 },
    beforeState: { position: 0 },
    afterState: { position: 1 },
    dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
  };
  return {
    ...base,
    ...overrides,
    actor: overrides.actor ?? base.actor,
    target: { ...base.target, ...(overrides.target ?? {}) },
    amount: overrides.amount === null
      ? null
      : { ...base.amount, ...(overrides.amount ?? {}) },
    dataFreshness: overrides.dataFreshness ?? base.dataFreshness,
  };
}

async function createFinancialApproval(userId, proposedAction, overrides = {}) {
  return admin.rpc("create_approval_with_activity", {
    p_user_id: userId,
    p_task_id: null,
    p_action_class: "FINANCIAL_EXECUTION",
    p_requirement: "approval_step_up",
    p_reasons: ["Financial execution requires approval and step-up."],
    p_proposed_action: proposedAction,
    p_scope: "one_time",
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

try {
  for (const suffix of ["a", "b"]) {
    const email = `axis-cas-${run}-${suffix}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`Local validation user creation failed: ${error?.status ?? "unknown"}`);
    users.push({ id: data.user.id, email });
  }

  const userA = await authenticated(users[0].email);
  const userB = await authenticated(users[1].email);

  const task = await createTask(users[0].id, "task-race");
  const taskRace = await Promise.all([
    admin.rpc("cas_agent_task_transition", {
      p_user_id: users[0].id,
      p_task_id: task.id,
      p_expected_status: "queued",
      p_next_status: "gathering_data",
      p_completed_at: null,
    }),
    admin.rpc("cas_agent_task_transition", {
      p_user_id: users[0].id,
      p_task_id: task.id,
      p_expected_status: "queued",
      p_next_status: "cancelled",
      p_completed_at: new Date().toISOString(),
    }),
  ]);
  const taskOutcomes = taskRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(taskOutcomes) === JSON.stringify(["conflict", "updated"]),
    "concurrent task transitions have exactly one winner",
  );
  const { count: taskActivityCount, error: taskActivityError } = await admin
    .from("agent_task_activity")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id);
  if (taskActivityError) throw taskActivityError;
  check(taskActivityCount === 2, "task creation and winning transition each have one audit row");

  const terminalTask = await createTask(users[0].id, "terminal");
  outcome(await admin.rpc("cas_agent_task_transition", {
    p_user_id: users[0].id,
    p_task_id: terminalTask.id,
    p_expected_status: "queued",
    p_next_status: "cancelled",
    p_completed_at: new Date().toISOString(),
  }));
  const revive = await admin.rpc("cas_agent_task_transition", {
    p_user_id: users[0].id,
    p_task_id: terminalTask.id,
    p_expected_status: "cancelled",
    p_next_status: "queued",
    p_completed_at: null,
  });
  check(Boolean(revive.error), "terminal tasks cannot be revived through the RPC");

  const approvalTask = await createTask(users[0].id, "approval-race");
  const pendingApproval = await createApproval(users[0].id, approvalTask.id, "decision race");
  const { count: requestAuditCount, error: requestAuditError } = await admin
    .from("agent_task_activity")
    .select("id", { count: "exact", head: true })
    .eq("task_id", approvalTask.id)
    .eq("kind", "approval_request");
  if (requestAuditError) throw requestAuditError;
  check(requestAuditCount === 1, "approval creation and request audit commit together");

  const decisionRace = await Promise.all([
    admin.rpc("cas_approval_transition", {
      p_user_id: users[0].id,
      p_approval_id: pendingApproval.id,
      p_expected_status: "pending",
      p_next_status: "approved",
      p_decided_at: new Date().toISOString(),
    }),
    admin.rpc("cas_approval_transition", {
      p_user_id: users[0].id,
      p_approval_id: pendingApproval.id,
      p_expected_status: "pending",
      p_next_status: "denied",
      p_decided_at: new Date().toISOString(),
    }),
  ]);
  const decisionOutcomes = decisionRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(decisionOutcomes) === JSON.stringify(["conflict", "updated"]),
    "concurrent approve/deny has exactly one winner",
  );

  const executableApproval = await createApproval(users[0].id, approvalTask.id, "execute race");
  const approved = outcome(await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: executableApproval.id,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  }));
  check(approved.outcome === "updated", "approval can be decided through the atomic transition");
  const genericExecution = await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: executableApproval.id,
    p_expected_status: "approved",
    p_next_status: "executed",
    p_decided_at: null,
  });
  check(
    Boolean(genericExecution.error),
    "generic transition cannot execute approvals outside the policy-aware consumer",
  );
  const executeRace = await Promise.all([
    admin.rpc("consume_actionable_approval", {
      p_user_id: users[0].id,
      p_approval_id: executableApproval.id,
      p_now: new Date().toISOString(),
    }),
    admin.rpc("consume_actionable_approval", {
      p_user_id: users[0].id,
      p_approval_id: executableApproval.id,
      p_now: new Date().toISOString(),
    }),
  ]);
  const executeOutcomes = executeRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(executeOutcomes) === JSON.stringify(["conflict", "updated"]),
    "concurrent execute clears an approval exactly once",
  );

  const malformedApproval = await createApproval(
    users[0].id,
    approvalTask.id,
    "malformed persisted scope",
  );
  outcome(await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: malformedApproval.id,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  }));
  const { error: malformedUpdateError } = await admin
    .from("approvals")
    .update({ proposed_action: {}, reasons: [] })
    .eq("id", malformedApproval.id);
  if (malformedUpdateError) throw malformedUpdateError;
  const malformedConsume = outcome(await admin.rpc("consume_actionable_approval", {
    p_user_id: users[0].id,
    p_approval_id: malformedApproval.id,
    p_now: new Date().toISOString(),
  }));
  check(
    malformedConsume.outcome === "not_actionable",
    "execute revalidates persisted approval completeness",
  );

  const backdatedApproval = await createApproval(
    users[0].id,
    approvalTask.id,
    "backdated execution",
  );
  outcome(await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: backdatedApproval.id,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  }));
  const backdatedConsume = await admin.rpc("consume_actionable_approval", {
    p_user_id: users[0].id,
    p_approval_id: backdatedApproval.id,
    p_now: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
  check(
    Boolean(backdatedConsume.error),
    "execute rejects caller-supplied timestamps outside the server clock window",
  );

  const foreign = outcome(await admin.rpc("cas_agent_task_transition", {
    p_user_id: users[1].id,
    p_task_id: task.id,
    p_expected_status: "queued",
    p_next_status: "cancelled",
    p_completed_at: new Date().toISOString(),
  }));
  check(foreign.outcome === "not_found", "foreign owner IDs are indistinguishable from missing rows");

  const { data: foreignRows, error: foreignReadError } = await userB
    .from("agent_tasks")
    .select("id")
    .eq("id", task.id);
  if (foreignReadError) throw foreignReadError;
  check(foreignRows.length === 0, "RLS hides another user's task");

  const directTaskUpdate = await userA
    .from("agent_tasks")
    .update({ status: "completed" })
    .eq("id", task.id);
  check(Boolean(directTaskUpdate.error), "authenticated clients cannot update task lifecycle state directly");

  const directTaskInsert = await userA.from("agent_tasks").insert({
    user_id: users[0].id,
    objective: "unaudited direct insert",
    status: "queued",
  });
  check(Boolean(directTaskInsert.error), "authenticated clients cannot bypass atomic task creation");

  const directActivityInsert = await userA.from("agent_task_activity").insert({
    task_id: task.id,
    user_id: users[0].id,
    kind: "status_change",
    detail: { forged: true },
  });
  check(Boolean(directActivityInsert.error), "authenticated clients cannot forge task audit rows");

  const directTaskDelete = await userA
    .from("agent_tasks")
    .delete()
    .eq("id", task.id);
  check(Boolean(directTaskDelete.error), "authenticated clients cannot erase task audit history");

  const directApprovalUpdate = await userA
    .from("approvals")
    .update({ step_up_verified_at: new Date().toISOString() })
    .eq("id", pendingApproval.id);
  check(Boolean(directApprovalUpdate.error), "authenticated clients cannot self-stamp approval step-up");

  const directRpc = await userA.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: pendingApproval.id,
    p_expected_status: "pending",
    p_next_status: "denied",
    p_decided_at: new Date().toISOString(),
  });
  check(Boolean(directRpc.error), "authenticated clients cannot execute lifecycle RPCs");

  const predecidedInsert = await userA.from("approvals").insert({
    user_id: users[0].id,
    action_class: "INTERNAL_WRITE",
    requirement: "approval",
    reasons: ["validation"],
    proposed_action: { validation: true },
    status: "approved",
    decided_at: new Date().toISOString(),
    scope: "one_time",
  });
  check(Boolean(predecidedInsert.error), "approval inserts cannot arrive pre-decided");

  const forgedFinancialInsert = await userA.from("approvals").insert({
    user_id: users[0].id,
    action_class: "FINANCIAL_EXECUTION",
    requirement: "approval",
    reasons: ["forged"],
    proposed_action: { validation: true },
    status: "pending",
    scope: "persistent",
  });
  check(Boolean(forgedFinancialInsert.error), "authenticated clients cannot forge lower-policy financial approvals");

  const forgedFinancialRpc = await admin.rpc("create_approval_with_activity", {
    p_user_id: users[0].id,
    p_task_id: null,
    p_action_class: "FINANCIAL_EXECUTION",
    p_requirement: "approval",
    p_reasons: ["forged"],
    p_proposed_action: {
      actor: { kind: "agent", id: "forged" },
      tool: "public.place_order",
      summary: "forged order",
      target: { entityType: "order", accountId: "account" },
      amount: { value: 1, currency: "USD" },
      beforeState: {},
      afterState: {},
      dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
    },
    p_scope: "persistent",
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  check(Boolean(forgedFinancialRpc.error), "database policy rejects downgraded financial approvals");

  const malformedFinancialCases = [
    ["routine actor without a version", financialScope({ actor: { kind: "routine", id: "rebalance" } }), {}],
    ["forged user actor", financialScope({ actor: { kind: "user", id: users[1].id } }), {}],
    ["blank financial tool", financialScope({ tool: "   " }), {}],
    ["non-positive financial amount", financialScope({ amount: { value: 0 } }), {}],
    ["non-positive financial quantity", financialScope({ amount: { quantity: 0 } }), {}],
    ["non-ISO financial currency", financialScope({ amount: { currency: "usd" } }), {}],
    ["blank financial account", financialScope({ target: { accountId: "   " } }), {}],
    ["non-object financial before-state", financialScope({ beforeState: null }), {}],
    ["non-object financial after-state", financialScope({ afterState: [] }), {}],
    [
      "stale financial freshness tier",
      financialScope({
        dataFreshness: { tier: "stale", retrievedAt: new Date().toISOString() },
      }),
      {},
    ],
    [
      "future financial freshness",
      financialScope({
        dataFreshness: {
          tier: "fresh",
          retrievedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      }),
      {},
    ],
    [
      "too-old financial freshness",
      financialScope({
        dataFreshness: {
          tier: "delayed",
          retrievedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
        },
      }),
      {},
    ],
    [
      "invalid financial freshness timestamp",
      financialScope({
        dataFreshness: { tier: "fresh", retrievedAt: "2026-02-31T12:00:00.000Z" },
      }),
      {},
    ],
    [
      "financial expiry beyond 24 hours",
      financialScope(),
      { p_expires_at: new Date(Date.now() + 25 * 60 * 60_000).toISOString() },
    ],
    [
      "non-boolean action risk flag",
      financialScope({ touchesSensitiveData: "yes" }),
      {},
    ],
  ];
  for (const [label, proposedAction, overrides] of malformedFinancialCases) {
    const result = await createFinancialApproval(users[0].id, proposedAction, overrides);
    check(Boolean(result.error), `database rejects ${label}`);
  }

  const validFinancial = outcome(await createFinancialApproval(
    users[0].id,
    financialScope(),
  )).approval;
  outcome(await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: validFinancial.id,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  }));
  const { error: corruptFinancialError } = await admin
    .from("approvals")
    .update({
      proposed_action: financialScope({
        amount: { value: -100 },
        dataFreshness: {
          tier: "fresh",
          retrievedAt: new Date().toISOString(),
        },
      }),
    })
    .eq("id", validFinancial.id);
  if (corruptFinancialError) throw corruptFinancialError;
  const corruptFinancialConsume = outcome(await admin.rpc("consume_actionable_approval", {
    p_user_id: users[0].id,
    p_approval_id: validFinancial.id,
    p_now: new Date().toISOString(),
  }));
  check(
    corruptFinancialConsume.outcome === "not_actionable",
    "consumer rejects a malformed privileged financial row",
  );

  const directCompletenessRpc = await userA.rpc("is_approval_scope_complete", {
    p_user_id: users[0].id,
    p_action_class: "INTERNAL_WRITE",
    p_requirement: "approval",
    p_reasons: ["validation"],
    p_proposed_action: {
      actor: { kind: "agent", id: "axis-validation" },
      tool: "axis.update_record",
      summary: "validation",
      target: { entityType: "record" },
    },
    p_scope: "one_time",
    p_expires_at: null,
    p_created_at: new Date().toISOString(),
    p_now: new Date().toISOString(),
  });
  check(Boolean(directCompletenessRpc.error), "canonical approval predicate is service-only");

  const taskB = await createTask(users[1].id, "cross-owner");
  const crossOwnerApproval = await userA.from("approvals").insert({
    user_id: users[0].id,
    task_id: taskB.id,
    action_class: "INTERNAL_WRITE",
    requirement: "approval",
    reasons: ["validation"],
    proposed_action: { validation: true },
    status: "pending",
    scope: "one_time",
  });
  check(Boolean(crossOwnerApproval.error), "composite owner keys reject cross-user task links");

  const routineApproval = await createApproval(users[0].id, null, "routine-owned");
  outcome(await admin.rpc("cas_approval_transition", {
    p_user_id: users[0].id,
    p_approval_id: routineApproval.id,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  }));
  const { data: routineRun, error: routineRunError } = await admin
    .from("routine_runs")
    .insert({
      user_id: users[0].id,
      routine_key: "validation",
      status: "waiting_for_approval",
      paused_step_key: "validation_step",
      approval_id: routineApproval.id,
      trigger: "manual",
      input_snapshot: {},
    })
    .select("id")
    .single();
  if (routineRunError) throw routineRunError;
  const routineConsume = outcome(await admin.rpc("consume_actionable_approval", {
    p_user_id: users[0].id,
    p_approval_id: routineApproval.id,
    p_now: new Date().toISOString(),
  }));
  check(routineConsume.outcome === "routine_owned", "generic execute cannot orphan a waiting routine");

  const expiringTask = await createTask(users[0].id, "expiry-audit");
  const expiringApproval = await createApproval(users[0].id, expiringTask.id, "expiry", {
    p_action_class: "EXTERNAL_COMMUNICATION",
    p_requirement: "approval",
    p_proposed_action: {
      actor: { kind: "agent", id: "axis-validation" },
      tool: "mail.send",
      summary: "Send validation message",
      target: { entityType: "message" },
      dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
    },
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const { error: forceExpiryError } = await admin
    .from("approvals")
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", expiringApproval.id);
  if (forceExpiryError) throw forceExpiryError;
  outcome(await admin.rpc("expire_stale_approvals"));
  const { count: expiryAuditCount, error: expiryAuditError } = await admin
    .from("agent_task_activity")
    .select("id", { count: "exact", head: true })
    .eq("task_id", expiringTask.id)
    .eq("kind", "approval_decision");
  if (expiryAuditError) throw expiryAuditError;
  check(expiryAuditCount === 1, "maintenance expiry writes the linked approval audit atomically");

  const challengeId = randomUUID();
  const siblingChallengeId = randomUUID();
  const challenge = randomUUID();
  const challengeExpiry = new Date(Date.now() + 60_000).toISOString();
  const { error: challengeInsertError } = await admin.from("webauthn_challenges").insert([
    {
      id: challengeId,
      challenge,
      type: "authentication",
      user_id: users[0].id,
      approval_id: routineApproval.id,
      expires_at: challengeExpiry,
    },
    {
      id: siblingChallengeId,
      challenge: randomUUID(),
      type: "authentication",
      user_id: users[0].id,
      approval_id: routineApproval.id,
      expires_at: challengeExpiry,
    },
  ]);
  if (challengeInsertError) throw challengeInsertError;
  const challengeRace = await Promise.all([
    admin.rpc("consume_approval_authentication_challenge", {
      p_user_id: users[0].id,
      p_approval_id: routineApproval.id,
      p_challenge_id: challengeId,
      p_now: new Date().toISOString(),
    }),
    admin.rpc("consume_approval_authentication_challenge", {
      p_user_id: users[0].id,
      p_approval_id: routineApproval.id,
      p_challenge_id: challengeId,
      p_now: new Date().toISOString(),
    }),
  ]);
  const challengeOutcomes = challengeRace.map(outcome).map((value) => value.outcome).sort();
  check(
    JSON.stringify(challengeOutcomes) === JSON.stringify(["consumed", "not_found"]),
    "a WebAuthn approval challenge can be consumed only once",
  );
  const { count: siblingCount, error: siblingError } = await admin
    .from("webauthn_challenges")
    .select("id", { count: "exact", head: true })
    .eq("id", siblingChallengeId);
  if (siblingError) throw siblingError;
  check(siblingCount === 1, "challenge consumption is bound to the exact ceremony ID");

  const stepUpTask = await createTask(users[0].id, "step-up-audit");
  const stepUpApproval = await createApproval(users[0].id, stepUpTask.id, "step-up", {
    p_action_class: "DESTRUCTIVE_ADMIN",
    p_requirement: "approval_step_up",
    p_proposed_action: {
      actor: { kind: "agent", id: "axis-validation" },
      tool: "integration.disconnect",
      summary: "Disconnect validation integration",
      target: { entityType: "integration" },
      beforeState: { connected: true },
      dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
    },
    p_scope: "one_time",
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const passkeyId = randomUUID();
  const { error: passkeyInsertError } = await admin.from("user_passkeys").insert({
    id: passkeyId,
    user_id: users[0].id,
    credential_id: randomUUID(),
    credential_public_key: "validation",
    counter: 0,
    name: "validation",
  });
  if (passkeyInsertError) throw passkeyInsertError;
  const committedStepUp = outcome(await admin.rpc("commit_approval_step_up", {
    p_user_id: users[0].id,
    p_approval_id: stepUpApproval.id,
    p_expected_approval_status: "pending",
    p_passkey_id: passkeyId,
    p_expected_counter: 0,
    p_new_counter: 1,
    p_verified_at: new Date().toISOString(),
  }));
  check(committedStepUp.outcome === "updated", "passkey counter and approval step-up commit together");
  const staleCounter = outcome(await admin.rpc("commit_approval_step_up", {
    p_user_id: users[0].id,
    p_approval_id: stepUpApproval.id,
    p_expected_approval_status: "pending",
    p_passkey_id: passkeyId,
    p_expected_counter: 0,
    p_new_counter: 1,
    p_verified_at: new Date().toISOString(),
  }));
  check(staleCounter.outcome === "counter_conflict", "stale passkey counters cannot replay step-up");
  const directPasskeyUpdate = await userA
    .from("user_passkeys")
    .update({ credential_public_key: "forged" })
    .eq("id", passkeyId);
  check(Boolean(directPasskeyUpdate.error), "authenticated clients cannot replace passkey security material");
  const directPasskeyInsert = await userA.from("user_passkeys").insert({
    user_id: users[0].id,
    credential_id: randomUUID(),
    credential_public_key: "forged",
    counter: 0,
    name: "forged",
  });
  check(Boolean(directPasskeyInsert.error), "authenticated clients cannot self-register passkeys outside verification");
  const directPasskeyDelete = await userA
    .from("user_passkeys")
    .delete()
    .eq("id", passkeyId);
  check(Boolean(directPasskeyDelete.error), "authenticated clients cannot delete passkeys outside the server route");

  const deletionTask = await createTask(users[0].id, "deletion");
  const { data: deletionApproval, error: deletionApprovalError } = await admin
    .from("approvals")
    .insert({
      user_id: users[0].id,
      task_id: deletionTask.id,
      action_class: "INTERNAL_WRITE",
      requirement: "approval",
      reasons: ["validation"],
      proposed_action: { validation: true },
      status: "pending",
      scope: "one_time",
    })
    .select("id")
    .single();
  if (deletionApprovalError) throw deletionApprovalError;
  const { error: deletionError } = await admin
    .from("agent_tasks")
    .delete()
    .eq("id", deletionTask.id);
  if (deletionError) throw deletionError;
  const { data: preservedApproval, error: preservedApprovalError } = await admin
    .from("approvals")
    .select("task_id, user_id")
    .eq("id", deletionApproval.id)
    .single();
  if (preservedApprovalError) throw preservedApprovalError;
  check(
    preservedApproval.task_id === null && preservedApproval.user_id === users[0].id,
    "task deletion clears only the approval link and preserves audit ownership",
  );

  await admin.from("routine_runs").delete().eq("id", routineRun.id);

  console.log("task/approval CAS validation complete");
} finally {
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id);
  }
}
