import { z } from "zod";

export const aiResponseMetadataSchema = z.union([
  z.object({
    source: z.literal("model"),
    degraded: z.literal(false),
    reason: z.null(),
  }).strict(),
  z.object({
    source: z.literal("heuristic"),
    degraded: z.literal(true),
    reason: z.enum([
      "not_configured",
      "provider_error",
      "provider_rate_limited",
    ]),
  }).strict(),
]);

export type AiResponseMetadata = z.infer<typeof aiResponseMetadataSchema>;
export type AiResponse<T extends object> = T & {
  meta: AiResponseMetadata;
};

export const MODEL_AI_RESPONSE_METADATA: AiResponseMetadata = Object.freeze({
  source: "model",
  degraded: false,
  reason: null,
});

export function degradedAiResponseMetadata(
  reason: Extract<AiResponseMetadata, { degraded: true }>["reason"],
): AiResponseMetadata {
  return {
    source: "heuristic",
    degraded: true,
    reason,
  };
}

export function withAiResponseMetadata<T extends object>(
  payload: T,
  meta: AiResponseMetadata,
): AiResponse<T> {
  return { ...payload, meta };
}

export function parseAiResponseMetadata(value: unknown): AiResponseMetadata | null {
  const parsed = aiResponseMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function aiDegradationLabel(
  reason: Extract<AiResponseMetadata, { degraded: true }>["reason"],
): string {
  if (reason === "not_configured") return "Local heuristic · AI provider not configured";
  if (reason === "provider_rate_limited") return "Local heuristic · AI provider rate limited";
  return "Local heuristic · AI provider unavailable";
}
