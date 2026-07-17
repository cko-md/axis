import { ALL_NAV_ITEMS } from "@/lib/store/nav";
import { z } from "zod";

const SIMPLE_INTERNAL_PATH = /^\/[a-z0-9-]+\/?$/;

export const AI_INTERNAL_ACTION_PATHS = Object.freeze(
  [...new Set(
    ALL_NAV_ITEMS
      .map((item) => item.href)
      .filter((href) => /^\/[a-z0-9-]+$/.test(href)),
  )],
);

const AI_INTERNAL_ACTION_PATH_SET = new Set<string>(AI_INTERNAL_ACTION_PATHS);

function cleanCardText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return clean || null;
}

/**
 * Converts a model-authored navigation suggestion into a known AXIS module
 * root. A trailing slash is canonicalized; arbitrary paths, query/hash
 * fragments, schemes, protocol-relative URLs, backslashes, encoded paths, and
 * nested routes are rejected.
 */
export function normalizeAiActionPath(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const candidate = value.trim();
  if (
    !candidate
    || !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("\\")
    || candidate.includes("%")
    || candidate.includes("?")
    || candidate.includes("#")
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }

  if (!SIMPLE_INTERNAL_PATH.test(candidate)) return null;

  const canonicalPath = candidate.length > 1 && candidate.endsWith("/")
    ? candidate.slice(0, -1)
    : candidate;

  return AI_INTERNAL_ACTION_PATH_SET.has(canonicalPath)
    ? canonicalPath
    : null;
}

const safeActionPathSchema = z.string().transform((value, context) => {
  const normalized = normalizeAiActionPath(value);
  if (!normalized) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Action path must be an allowlisted AXIS module root",
    });
    return z.NEVER;
  }
  return normalized;
});

export const aiDeckCardSchema = z.object({
  id: z.string().min(1).max(16),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  actionLabel: z.string().min(1).max(80).optional(),
  actionPath: safeActionPathSchema.optional(),
}).strict().superRefine((card, context) => {
  if (Boolean(card.actionLabel) !== Boolean(card.actionPath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Action label and path must be supplied together",
    });
  }
});

export type AiDeckCard = z.infer<typeof aiDeckCardSchema>;

/**
 * Treats model cards as untrusted input. Only the documented card fields cross
 * the boundary, and an action is included only when both its label and path
 * are valid.
 */
export function sanitizeAiDeckCards(value: unknown): AiDeckCard[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 5).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];

    const card = entry as Record<string, unknown>;
    const title = cleanCardText(card.title, 120);
    const body = cleanCardText(card.body, 500);
    if (!title || !body) return [];

    const actionLabel = cleanCardText(card.actionLabel, 80);
    const actionPath = normalizeAiActionPath(card.actionPath);

    return [{
      id: String(index),
      title,
      body,
      ...(actionLabel && actionPath ? { actionLabel, actionPath } : {}),
    }];
  });
}
