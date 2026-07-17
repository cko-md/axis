import { z } from "zod";

export const MEMORY_KINDS = ["preference", "constraint", "goal", "context"] as const;
export const MEMORY_SCOPES = ["global", "financial", "routine", "integration"] as const;
export const MEMORY_STATUSES = ["active", "archived"] as const;
export const MEMORY_SOURCE_TYPES = ["user_asserted", "provider_import", "system_observed"] as const;

export const RISK_POSTURES = [
  "capital_preservation",
  "conservative",
  "balanced",
  "growth",
  "aggressive",
] as const;
export const INVESTMENT_HORIZONS = ["under_3_years", "3_to_7_years", "7_to_15_years", "long_term"] as const;

const nullableExpiry = z.union([z.string().datetime({ offset: true }), z.null()]);

export const memoryCreateSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(MEMORY_SCOPES),
  content: z.string().trim().min(1).max(1200),
  confidence_bps: z.number().int().min(0).max(10000),
  expires_at: nullableExpiry,
}).strict();

export const memoryUpdateSchema = memoryCreateSchema.partial().extend({
  status: z.enum(MEMORY_STATUSES).optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field is required." },
);

const boundedList = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);

export const financialProfileSchema = z.object({
  base_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  risk_posture: z.enum(RISK_POSTURES),
  investment_horizon: z.enum(INVESTMENT_HORIZONS),
  liquidity_buffer_months: z.number().int().min(0).max(120),
  concentration_limit_bps: z.number().int().min(100).max(10000),
  priorities: boundedList(8, 80),
  constraints: boundedList(12, 160),
}).strict();

export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>;
export type MemoryUpdateInput = z.infer<typeof memoryUpdateSchema>;
export type FinancialProfileInput = z.infer<typeof financialProfileSchema>;

export function isExpired(expiresAt: string | null, now = new Date()): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= now.getTime();
}

export function confidencePercent(confidenceBps: number): string {
  return `${Math.round(confidenceBps / 100)}%`;
}
