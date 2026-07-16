import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { TASK_STATUSES, TASK_TRANSITIONS } from "./taskState";
import {
  createAgentTaskWithActivity,
  transitionAgentTask,
} from "./taskPersistence";

function client(data: unknown, error: unknown = null) {
  return {
    rpc: vi.fn(async () => ({ data, error })),
  } as unknown as SupabaseClient<Database>;
}

describe("atomic task persistence", () => {
  it("keeps the database defense-in-depth transitions aligned with the typed kernel", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/202607161300_task_approval_atomic.sql"),
      "utf8",
    );
    for (const status of TASK_STATUSES) {
      const match = sql.match(new RegExp(
        `when '${status}' then p_next_status in \\(([\\s\\S]*?)\\)`,
      ));
      const databaseTargets = match
        ? [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
        : [];
      expect(new Set(databaseTargets), status).toEqual(new Set(TASK_TRANSITIONS[status]));
    }
  });

  it("parses the task committed with its initial activity", async () => {
    const db = client({
      outcome: "created",
      task: { id: "task_1", objective: "Inspect drift", status: "queued" },
    });
    const result = await createAgentTaskWithActivity({
      userId: "user_1",
      objective: "Inspect drift",
      context: {},
    }, db);
    expect(result).toMatchObject({
      ok: true,
      outcome: "created",
      created: true,
      task: { id: "task_1", status: "queued" },
    });
  });

  it("uses the atomic idempotent task RPC and accepts the existing winner", async () => {
    const db = client({
      outcome: "existing",
      task: { id: "task_1", objective: "Inspect drift", status: "queued" },
    });
    const result = await createAgentTaskWithActivity({
      userId: "user_1",
      objective: "Inspect drift",
      context: { idempotency_key: "resume-key:task:AAPL" },
      sourceRoutineId: "run_1",
      idempotencyKey: "resume-key:task:AAPL",
    }, db);

    expect(result).toMatchObject({
      ok: true,
      outcome: "existing",
      created: false,
      task: { id: "task_1" },
    });
    expect(db.rpc).toHaveBeenCalledWith(
      "create_idempotent_agent_task_with_activity",
      expect.objectContaining({
        p_source_routine_id: "run_1",
        p_idempotency_key: "resume-key:task:AAPL",
      }),
    );
  });

  it("preserves the canonical current status on a CAS conflict", async () => {
    const db = client({ outcome: "conflict", currentStatus: "cancelled" });
    const result = await transitionAgentTask({
      userId: "user_1",
      taskId: "task_1",
      expectedStatus: "queued",
      nextStatus: "gathering_data",
    }, db);
    expect(result).toEqual({ ok: false, code: "CONFLICT", currentStatus: "cancelled" });
  });

  it("fails closed on malformed RPC output", async () => {
    const result = await transitionAgentTask({
      userId: "user_1",
      taskId: "task_1",
      expectedStatus: "queued",
      nextStatus: "gathering_data",
    }, client({ outcome: "updated", task: null }));
    expect(result).toEqual({ ok: false, code: "INVALID_RESPONSE" });
  });
});
