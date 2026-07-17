import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

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

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed (${error.code ?? "unknown"})`);
  return data;
}

async function row(query, label) {
  const { data, error } = await query.single();
  if (error || !data) throw new Error(`${label} failed (${error?.code ?? "missing"})`);
  return data;
}

const local = localSupabaseEnv();
const url = local.API_URL;
const anonKey = local.ANON_KEY;
const serviceKey = local.SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase URL, anon key, and service role key are required");
}
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("Refusing to validate routine resume claims against a hosted Supabase URL");
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const password = `Axis-${randomUUID()}-9a!`;
const validationId = randomUUID();
const users = [];

async function createUser(suffix) {
  const email = `axis-routine-resume-${validationId}-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Local validation user creation failed (${error?.status ?? "unknown"})`);
  }
  const created = { id: data.user.id, email };
  users.push(created);
  return created;
}

async function authenticated(user) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (error) throw new Error(`Local validation sign-in failed (${error.status ?? "unknown"})`);
  return client;
}

async function createApproval(userId, label, overrides = {}) {
  const actionClass = overrides.actionClass ?? "INTERNAL_WRITE";
  const financial = actionClass === "FINANCIAL_EXECUTION";
  const proposedAction = financial
    ? {
        actor: { kind: "routine", id: "validator", routineVersion: 1 },
        tool: "public.place_order",
        summary: `Validate ${label}`,
        target: { entityType: "order", accountId: "validation-account" },
        amount: { value: 10, currency: "USD", quantity: 1 },
        beforeState: { shares: 0 },
        afterState: { shares: 1 },
        dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
      }
    : {
        actor: { kind: "routine", id: "validator", routineVersion: 1 },
        tool: "axis.create_task",
        summary: `Validate ${label}`,
        target: { entityType: "task" },
      };
  const created = await rpc(admin, "create_approval_with_activity", {
    p_user_id: userId,
    p_task_id: null,
    p_action_class: actionClass,
    p_requirement: financial ? "approval_step_up" : "approval",
    p_reasons: [`${actionClass} requires approval.`],
    p_proposed_action: proposedAction,
    p_scope: "one_time",
    p_expires_at: overrides.expiresAt ?? (financial
      ? new Date(Date.now() + 15 * 60_000).toISOString()
      : null),
  });
  return created.approval;
}

async function approve(userId, approvalId) {
  const result = await rpc(admin, "cas_approval_transition", {
    p_user_id: userId,
    p_approval_id: approvalId,
    p_expected_status: "pending",
    p_next_status: "approved",
    p_decided_at: new Date().toISOString(),
  });
  check(result.outcome === "updated", "approval enters approved state atomically");
}

async function createPausedRun(userId, approvalId, label, inputSnapshot = { validation: true }) {
  const idempotencyKey = `routine-resume:${validationId}:${label}`;
  const run = await row(
    admin
      .from("routine_runs")
      .insert({
        user_id: userId,
        routine_key: "concentration_review",
        routine_version: 1,
        status: "waiting_for_approval",
        trigger: "validation",
        input_snapshot: inputSnapshot,
        paused_step_key: "create_tasks",
        approval_id: approvalId,
        idempotency_key: idempotencyKey,
      })
      .select("id"),
    "paused run creation",
  );
  await row(
    admin
      .from("routine_step_runs")
      .insert({
        run_id: run.id,
        user_id: userId,
        step_key: "create_tasks",
        ordinal: 1,
        status: "running",
        input_snapshot: { validation: true },
        attempt: 1,
        started_at: new Date().toISOString(),
      })
      .select("id"),
    "paused step creation",
  );
  return { id: run.id, idempotencyKey };
}

async function readRun(userId, runId) {
  return row(
    admin
      .from("routine_runs")
      .select(
        "id, status, error, paused_step_key, approval_id, idempotency_key, "
          + "resume_claim_token, resume_claim_expires_at, resume_attempt, output",
      )
      .eq("user_id", userId)
      .eq("id", runId),
    "run read",
  );
}

async function release(userId, runId, token, errorCode = null) {
  return rpc(admin, "release_routine_resume_claim", {
    p_user_id: userId,
    p_run_id: runId,
    p_claim_token: token,
    p_error_code: errorCode,
  });
}

try {
  const userA = await createUser("a");
  const userB = await createUser("b");
  const browserA = await authenticated(userA);

  const approval = await createApproval(userA.id, "claim-race");
  await approve(userA.id, approval.id);
  const run = await createPausedRun(userA.id, approval.id, "claim-race");
  const tokenA = randomUUID();
  const tokenB = randomUUID();
  const claims = await Promise.all([
    admin.rpc("claim_routine_resume", {
      p_user_id: userA.id,
      p_run_id: run.id,
      p_claim_token: tokenA,
      p_lease_seconds: 2,
    }),
    admin.rpc("claim_routine_resume", {
      p_user_id: userA.id,
      p_run_id: run.id,
      p_claim_token: tokenB,
      p_lease_seconds: 2,
    }),
  ]);
  const claimValues = claims.map((result) => {
    if (result.error) throw new Error(`claim race failed (${result.error.code ?? "unknown"})`);
    return result.data;
  });
  const outcomes = claimValues.map((value) => value.outcome).sort();
  check(
    JSON.stringify(outcomes) === JSON.stringify(["busy", "claimed"]),
    "concurrent resume claims have exactly one winner",
  );
  const winnerIndex = claimValues.findIndex((value) => value.outcome === "claimed");
  const winnerToken = winnerIndex === 0 ? tokenA : tokenB;
  const staleToken = winnerIndex === 0 ? tokenB : tokenA;
  const claimed = claimValues[winnerIndex];
  check(claimed.idempotencyKey === run.idempotencyKey, "claim returns the stored idempotency key");

  const approvalAfterClaim = await row(
    admin.from("approvals").select("status").eq("id", approval.id),
    "approval read after claim",
  );
  check(approvalAfterClaim.status === "approved", "claim does not pre-consume approval");

  const reusedClaim = await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: winnerToken,
    p_lease_seconds: 2,
  });
  check(
    reusedClaim.outcome === "claimed"
      && reusedClaim.reused === true
      && reusedClaim.routineKey === "concentration_review",
    "same-token claim retry is idempotent and complete",
  );

  const staleRenew = await rpc(admin, "renew_routine_resume_claim", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: staleToken,
    p_lease_seconds: 2,
  });
  check(staleRenew.outcome === "claim_lost", "non-owner claim tokens are fenced");

  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const replacementToken = randomUUID();
  const replacementClaim = await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: replacementToken,
    p_lease_seconds: 30,
  });
  check(replacementClaim.outcome === "claimed", "a new token can reclaim an expired lease");

  const expiredTokenStep = await rpc(admin, "complete_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: winnerToken,
    p_step_run_id: (
      await row(
        admin
          .from("routine_step_runs")
          .select("id")
          .eq("run_id", run.id)
          .eq("status", "running"),
        "running step read",
      )
    ).id,
    p_output_snapshot: { invalid: true },
  });
  check(expiredTokenStep.outcome === "claim_lost", "expired claim tokens cannot complete steps");

  const started = await rpc(admin, "start_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: replacementToken,
    p_step_key: "create_tasks",
    p_ordinal: 1,
    p_input_snapshot: { validation: true },
  });
  check(started.outcome === "started" && started.reused === true, "paused running step start is fenced and reused");

  const renewed = await rpc(admin, "renew_routine_resume_claim", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: replacementToken,
    p_lease_seconds: 30,
  });
  check(renewed.outcome === "renewed", "active resume claims renew their lease");

  const failed = await rpc(admin, "fail_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: replacementToken,
    p_step_run_id: started.step.id,
    p_error_code: "VALIDATION_FAILURE",
  });
  check(failed.outcome === "failed", "claimed step failure is recorded through the fence");
  const released = await release(
    userA.id,
    run.id,
    replacementToken,
    "VALIDATION_FAILURE",
  );
  check(released.outcome === "released", "failed resume releases its claim");
  const waitingAfterFailure = await readRun(userA.id, run.id);
  check(
    waitingAfterFailure.status === "waiting_for_approval"
      && waitingAfterFailure.approval_id === approval.id
      && waitingAfterFailure.idempotency_key === run.idempotencyKey
      && waitingAfterFailure.paused_step_key === "create_tasks"
      && waitingAfterFailure.resume_claim_token === null,
    "failure release preserves approval and pause audit metadata",
  );

  const successToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: successToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "released resume can be retried");
  const retriedStep = await rpc(admin, "start_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: successToken,
    p_step_key: "create_tasks",
    p_ordinal: 1,
    p_input_snapshot: { validation: true },
  });
  check(
    retriedStep.outcome === "started" && retriedStep.step.attempt === 2,
    "failed step retry creates a new durable attempt",
  );
  check((await rpc(admin, "complete_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: successToken,
    p_step_run_id: retriedStep.step.id,
    p_output_snapshot: { created: [], skipped: 1 },
  })).outcome === "completed", "claimed step completion succeeds");
  const completion = await rpc(admin, "complete_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: successToken,
    p_status: "completed",
    p_output: { total: 0, breaches: 0, created: [], skipped: 1 },
    p_actual_cost_usd: 0,
  });
  check(completion.outcome === "completed" && completion.reused === false, "run completion commits");
  const [completedRun, executedApproval] = await Promise.all([
    readRun(userA.id, run.id),
    row(admin.from("approvals").select("status").eq("id", approval.id), "executed approval read"),
  ]);
  check(
    completedRun.status === "completed"
      && completedRun.resume_claim_token === null
      && executedApproval.status === "executed",
    "approval execution and run success commit atomically",
  );
  const repeatedCompletion = await rpc(admin, "complete_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: successToken,
    p_status: "completed",
    p_output: { overwritten: true },
    p_actual_cost_usd: 99,
  });
  check(
    repeatedCompletion.outcome === "completed"
      && repeatedCompletion.reused === true
      && repeatedCompletion.actualCostUsd === 0,
    "terminal completion retry returns stored output and cost without overwrite",
  );
  const terminalClaim = await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: run.id,
    p_claim_token: randomUUID(),
    p_lease_seconds: 30,
  });
  check(terminalClaim.outcome === "terminal", "terminal runs cannot be claimed again");

  const taskIdempotencyKey = `routine-resume:${run.id}:create_tasks:agent_task:AAPL`;
  const taskArgs = {
    p_user_id: userA.id,
    p_objective: `Idempotent routine task ${validationId}`,
    p_context: { validation: true, idempotency_key: taskIdempotencyKey },
    p_source_routine_id: run.id,
    p_source_skill: "concentration_review",
    p_activity_detail: { validation: true },
    p_idempotency_key: taskIdempotencyKey,
  };
  const taskRace = await Promise.all([
    admin.rpc("create_idempotent_agent_task_with_activity", taskArgs),
    admin.rpc("create_idempotent_agent_task_with_activity", taskArgs),
  ]);
  const taskResults = taskRace.map((result) => {
    if (result.error) throw new Error(`idempotent task race failed (${result.error.code ?? "unknown"})`);
    return result.data;
  });
  check(
    new Set(taskResults.map((result) => result.task.id)).size === 1
      && JSON.stringify(taskResults.map((result) => result.outcome).sort())
        === JSON.stringify(["created", "existing"]),
    "overlapping workers create exactly one idempotent task",
  );
  const { count: idempotentTaskCount, error: idempotentTaskCountError } = await admin
    .from("agent_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userA.id)
    .eq("idempotency_key", taskIdempotencyKey);
  if (idempotentTaskCountError) throw idempotentTaskCountError;
  check(idempotentTaskCount === 1, "task idempotency is enforced by a unique database key");
  const idempotentTaskId = taskResults[0].task.id;
  const { count: idempotentActivityCount, error: idempotentActivityCountError } = await admin
    .from("agent_task_activity")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userA.id)
    .eq("task_id", idempotentTaskId)
    .eq("kind", "status_change");
  if (idempotentActivityCountError) throw idempotentActivityCountError;
  check(
    idempotentActivityCount === 1,
    "idempotent task creation records exactly one initial activity",
  );
  const taskPayloadConflict = await rpc(admin, "create_idempotent_agent_task_with_activity", {
    ...taskArgs,
    p_objective: `${taskArgs.p_objective} changed`,
  });
  check(
    taskPayloadConflict.outcome === "conflict"
      && taskPayloadConflict.reason === "idempotency_payload_mismatch",
    "same task idempotency key cannot silently reuse a different payload",
  );

  const expiringApproval = await createApproval(userA.id, "expiry-boundary", {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await approve(userA.id, expiringApproval.id);
  const expiringRun = await createPausedRun(userA.id, expiringApproval.id, "expiry-boundary");
  const expiryToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: expiringRun.id,
    p_claim_token: expiryToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "fresh approval can be claimed");
  const { error: expireUpdateError } = await admin
    .from("approvals")
    .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .eq("id", expiringApproval.id);
  if (expireUpdateError) throw expireUpdateError;
  const expiredRenewal = await rpc(admin, "renew_routine_resume_claim", {
    p_user_id: userA.id,
    p_run_id: expiringRun.id,
    p_claim_token: expiryToken,
    p_lease_seconds: 30,
  });
  check(expiredRenewal.outcome === "approval_expired", "lease renewal rechecks approval expiry");
  check((await release(userA.id, expiringRun.id, expiryToken, "APPROVAL_EXPIRED")).outcome === "released", "expired authorization releases cleanly");
  const expiredWaiting = await readRun(userA.id, expiringRun.id);
  check(
    expiredWaiting.status === "waiting_for_approval"
      && expiredWaiting.approval_id === expiringApproval.id
      && expiredWaiting.idempotency_key === expiringRun.idempotencyKey,
    "expiry failure preserves run approval metadata",
  );

  const completionExpiryApproval = await createApproval(userA.id, "completion-expiry", {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await approve(userA.id, completionExpiryApproval.id);
  const completionExpiryRun = await createPausedRun(
    userA.id,
    completionExpiryApproval.id,
    "completion-expiry",
  );
  const completionExpiryToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: completionExpiryRun.id,
    p_claim_token: completionExpiryToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "completion-expiry run can be claimed");
  const completionExpiryStep = await row(
    admin
      .from("routine_step_runs")
      .select("id")
      .eq("run_id", completionExpiryRun.id)
      .eq("status", "running"),
    "completion-expiry step read",
  );
  check((await rpc(admin, "complete_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: completionExpiryRun.id,
    p_claim_token: completionExpiryToken,
    p_step_run_id: completionExpiryStep.id,
    p_output_snapshot: { validation: true },
  })).outcome === "completed", "completion-expiry step completes while authorized");
  const { error: completionExpireError } = await admin
    .from("approvals")
    .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .eq("id", completionExpiryApproval.id);
  if (completionExpireError) throw completionExpireError;
  const expiredCompletion = await rpc(admin, "complete_routine_resume", {
    p_user_id: userA.id,
    p_run_id: completionExpiryRun.id,
    p_claim_token: completionExpiryToken,
    p_status: "completed",
    p_output: { validation: true },
    p_actual_cost_usd: 0,
  });
  check(expiredCompletion.outcome === "approval_expired", "finalization rechecks approval expiry");
  check((await release(
    userA.id,
    completionExpiryRun.id,
    completionExpiryToken,
    "APPROVAL_EXPIRED",
  )).outcome === "released", "expired finalization releases cleanly");
  const completionExpiryWaiting = await readRun(userA.id, completionExpiryRun.id);
  check(
    completionExpiryWaiting.status === "waiting_for_approval"
      && completionExpiryWaiting.approval_id === completionExpiryApproval.id
      && completionExpiryWaiting.idempotency_key === completionExpiryRun.idempotencyKey,
    "failed expiry finalization preserves audit metadata",
  );

  const stepUpApproval = await createApproval(userA.id, "step-up-boundary", {
    actionClass: "FINANCIAL_EXECUTION",
  });
  await approve(userA.id, stepUpApproval.id);
  const { error: freshStepUpError } = await admin
    .from("approvals")
    .update({ step_up_verified_at: new Date().toISOString() })
    .eq("id", stepUpApproval.id);
  if (freshStepUpError) throw freshStepUpError;
  const stepUpRun = await createPausedRun(userA.id, stepUpApproval.id, "step-up-boundary");
  const stepUpToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: stepUpRun.id,
    p_claim_token: stepUpToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "fresh step-up approval can be claimed");
  const { error: staleStepUpError } = await admin
    .from("approvals")
    .update({ step_up_verified_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    .eq("id", stepUpApproval.id);
  if (staleStepUpError) throw staleStepUpError;
  const staleStepUpRenewal = await rpc(admin, "renew_routine_resume_claim", {
    p_user_id: userA.id,
    p_run_id: stepUpRun.id,
    p_claim_token: stepUpToken,
    p_lease_seconds: 30,
  });
  check(staleStepUpRenewal.outcome === "step_up_stale", "lease renewal rechecks step-up freshness");
  check((await release(userA.id, stepUpRun.id, stepUpToken, "APPROVAL_STEP_UP_STALE")).outcome === "released", "stale step-up releases cleanly");
  const { error: refreshedStepUpError } = await admin
    .from("approvals")
    .update({ step_up_verified_at: new Date().toISOString() })
    .eq("id", stepUpApproval.id);
  if (refreshedStepUpError) throw refreshedStepUpError;
  const stepUpCompletionToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: stepUpRun.id,
    p_claim_token: stepUpCompletionToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "refreshed step-up can reclaim the released run");
  const stepUpCompletionStep = await row(
    admin
      .from("routine_step_runs")
      .select("id")
      .eq("run_id", stepUpRun.id)
      .eq("status", "running"),
    "step-up completion step read",
  );
  check((await rpc(admin, "complete_claimed_routine_step", {
    p_user_id: userA.id,
    p_run_id: stepUpRun.id,
    p_claim_token: stepUpCompletionToken,
    p_step_run_id: stepUpCompletionStep.id,
    p_output_snapshot: { validation: true },
  })).outcome === "completed", "step-up completion step succeeds while fresh");
  const { error: completionStepUpError } = await admin
    .from("approvals")
    .update({ step_up_verified_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    .eq("id", stepUpApproval.id);
  if (completionStepUpError) throw completionStepUpError;
  const staleStepUpCompletion = await rpc(admin, "complete_routine_resume", {
    p_user_id: userA.id,
    p_run_id: stepUpRun.id,
    p_claim_token: stepUpCompletionToken,
    p_status: "completed",
    p_output: { validation: true },
    p_actual_cost_usd: 0,
  });
  check(staleStepUpCompletion.outcome === "step_up_stale", "finalization rechecks step-up freshness");
  check((await release(
    userA.id,
    stepUpRun.id,
    stepUpCompletionToken,
    "APPROVAL_STEP_UP_STALE",
  )).outcome === "released", "stale step-up finalization releases cleanly");
  const staleStepUpWaiting = await readRun(userA.id, stepUpRun.id);
  check(
    staleStepUpWaiting.status === "waiting_for_approval"
      && staleStepUpWaiting.approval_id === stepUpApproval.id
      && staleStepUpWaiting.idempotency_key === stepUpRun.idempotencyKey,
    "failed step-up finalization preserves audit metadata",
  );

  const oldApproval = await createApproval(userA.id, "repause-old");
  await approve(userA.id, oldApproval.id);
  const replacementApproval = await createApproval(userA.id, "repause-new");
  const repauseRun = await createPausedRun(userA.id, oldApproval.id, "repause-old");
  const repauseToken = randomUUID();
  check((await rpc(admin, "claim_routine_resume", {
    p_user_id: userA.id,
    p_run_id: repauseRun.id,
    p_claim_token: repauseToken,
    p_lease_seconds: 30,
  })).outcome === "claimed", "repause run can be claimed");
  const repaused = await rpc(admin, "repause_routine_resume", {
    p_user_id: userA.id,
    p_run_id: repauseRun.id,
    p_claim_token: repauseToken,
    p_step_key: "create_tasks",
    p_approval_id: replacementApproval.id,
    p_idempotency_key: `routine-resume:${validationId}:repause-new`,
  });
  check(repaused.outcome === "repaused", "replacement approval repause commits");
  const [repausedRun, expiredOld, pendingReplacement] = await Promise.all([
    readRun(userA.id, repauseRun.id),
    row(admin.from("approvals").select("status").eq("id", oldApproval.id), "old approval read"),
    row(admin.from("approvals").select("status").eq("id", replacementApproval.id), "replacement approval read"),
  ]);
  check(
    repausedRun.status === "waiting_for_approval"
      && repausedRun.approval_id === replacementApproval.id
      && repausedRun.resume_claim_token === null
      && expiredOld.status === "expired"
      && pendingReplacement.status === "pending",
    "repause atomically swaps approval metadata and expires the old grant",
  );

  const foreignClaim = await rpc(admin, "claim_routine_resume", {
    p_user_id: userB.id,
    p_run_id: repauseRun.id,
    p_claim_token: randomUUID(),
    p_lease_seconds: 30,
  });
  check(foreignClaim.outcome === "not_found", "foreign-owner run IDs are indistinguishable from missing");

  const browserClaimForge = await browserA
    .from("routine_runs")
    .update({
      resume_claim_token: randomUUID(),
      resume_claimed_at: new Date().toISOString(),
      resume_claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
      resume_attempt: 999,
    })
    .eq("id", repauseRun.id);
  check(Boolean(browserClaimForge.error), "authenticated clients cannot forge resume claims");
} finally {
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id).catch(() => undefined);
  }
}
