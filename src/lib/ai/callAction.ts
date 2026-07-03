"use client";

import {
  AI_ACTION_DEFS,
  buildAiRequestBody,
  type AiActionInput,
  type AiActionName,
  type AiActionOutput,
} from "@/lib/ai/actions";

export type AiActionResult<K extends AiActionName> =
  | { ok: true; data: AiActionOutput<K> }
  | { ok: false; error: string };

// Typed client entrypoint for an AI action. Validates the input against the
// registry (AI-2), POSTs the canonical `{ mode, ... }` body to `/api/ai`, and
// returns a typed Result. Callers get compile-time output types and never
// have to remember the wire shape — killing the `action` vs `mode` drift.
//
// The server always returns a documented fallback shape when the AI provider
// is unconfigured/errors, so a non-ok HTTP response here is a transport/auth
// failure, surfaced as a Result error for the caller to toast.
export async function callAiAction<K extends AiActionName>(
  action: K,
  input: AiActionInput<K>,
  init?: { signal?: AbortSignal },
): Promise<AiActionResult<K>> {
  let body: Record<string, unknown>;
  try {
    body = buildAiRequestBody(action, input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid AI request." };
  }

  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: init?.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `AI request failed (${res.status}).` };
    }
    const data = (await res.json()) as unknown;
    const parsed = AI_ACTION_DEFS[action].output.safeParse(data);
    if (!parsed.success) {
      return { ok: false, error: "AI returned an unexpected response." };
    }
    return { ok: true, data: parsed.data as AiActionOutput<K> };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: "Could not reach the AI service." };
  }
}
