import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON } from "@/lib/ai/router";
import { createClient } from "@/lib/supabase/server";
import { getGeminiApiKey, optionalEnv } from "@/lib/env";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";

// Destinations a signal can be routed into. Kept in sync with the client ROUTES list.
const DESTINATIONS = ["agenda", "schedule", "notes", "pipeline", "fund", "literature", "library", "people"] as const;
type Destination = (typeof DESTINATIONS)[number];
type SignalType = "action" | "awaiting" | "fyi";

type ClassifyInput = { id?: string; title: string; body?: string | null; source?: string | null };
type ClassifyResult = {
  id?: string;
  signal_type: SignalType;
  priority: "hi" | "med" | "lo";
  destination: Destination;
  reason: string;
  confidence: number;
};

function coerceDestination(d: string | undefined): Destination {
  const v = (d ?? "").toLowerCase().trim();
  return (DESTINATIONS as readonly string[]).includes(v) ? (v as Destination) : "agenda";
}

// Heuristic fallback — used when ANTHROPIC_API_KEY is absent or the model errors.
function heuristicClassify(input: ClassifyInput): ClassifyResult {
  const lower = `${input.title} ${input.body ?? ""} ${input.source ?? ""}`.toLowerCase();

  let signal_type: SignalType = "action";
  if (/awaiting|waiting|review|returned|comments|pending|reply|response|sent/.test(lower)) signal_type = "awaiting";
  if (/fyi|digest|summary|update|newsletter|notice|heads up/.test(lower)) signal_type = "fyi";

  let priority: "hi" | "med" | "lo" = "med";
  if (/urgent|asap|high|critical|sign|deadline|eod|today|due/.test(lower)) priority = "hi";
  if (/fyi|low|whenever|someday|digest/.test(lower)) priority = "lo";

  let destination: Destination = "agenda";
  if (/meeting|calendar|book|schedule|travel|window|appointment/.test(lower)) destination = "schedule";
  else if (/note|idea|thought|draft|memo/.test(lower)) destination = "notes";
  else if (/pr |pull request|code|review|merge|pipeline|deploy|build/.test(lower)) destination = "pipeline";
  else if (/portfolio|p&l|market|fund|polygon|ticker|trade|position/.test(lower)) destination = "fund";
  else if (/paper|preprint|arxiv|doi|citation|literature|abstract/.test(lower)) destination = "literature";
  else if (/contact|intro|person|email from|mentioned you/.test(lower)) destination = "people";

  return { id: input.id, signal_type, priority, destination, reason: "Heuristic match", confidence: 0.4 };
}

// Signal classification is a pure JSON task — routes through Gemini Flash first (free tier),
// falling back to Haiku if Gemini is unavailable.
async function aiClassify(client: Anthropic | null, input: ClassifyInput): Promise<ClassifyResult> {
  const parsed = await aiJSON<Partial<ClassifyResult>>({
    mode: "triage", // Gemini-eligible classification task
    anthropic: client,
    system:
      "You are the routing brain of a personal-OS signal inbox. Classify the signal and choose the best destination module. " +
      'Return ONLY a JSON object with keys: signal_type ("action"|"awaiting"|"fyi"), priority ("hi"|"med"|"lo"), ' +
      'destination ("agenda"|"schedule"|"notes"|"pipeline"|"fund"|"literature"|"library"|"people"), ' +
      "reason (max 12 words, why this destination), confidence (0-1 number). No markdown, no explanation.",
    userMessage: `title: ${input.title}\nbody: ${input.body ?? ""}\nsource: ${input.source ?? ""}`,
    maxTokens: 220,
  });
  return {
    id: input.id,
    signal_type: (parsed.signal_type as SignalType) ?? "action",
    priority: (parsed.priority as "hi" | "med" | "lo") ?? "med",
    destination: coerceDestination(parsed.destination),
    reason: parsed.reason ?? "Suggested route",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
  };
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 30 requests per minute per user (Redis when available, memory fallback)
  const { success } =
    (await redisRateLimit(user.id, 30, "1 m", "axis:signals-ai")) ??
    memoryRateLimit(`signals-ai:${user.id}`, 30, 60_000);
  if (!success) {
    return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
  }

  const payload = (await req.json()) as {
    mode?: string;
    // single
    title?: string;
    body?: string | null;
    source?: string | null;
    id?: string;
    // batch
    signals?: ClassifyInput[];
  };

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  const hasGemini = !!getGeminiApiKey();
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  const classifyOne = async (input: ClassifyInput): Promise<ClassifyResult> => {
    if (!client && !hasGemini) return heuristicClassify(input);
    try {
      return await aiClassify(client, input);
    } catch {
      return heuristicClassify(input);
    }
  };

  // Batch mode: classify many signals at once. Cap at 50 to bound AI spend.
  if (payload.mode === "batch" && Array.isArray(payload.signals)) {
    if (payload.signals.length > 50) {
      return NextResponse.json({ error: "Batch size exceeds limit of 50" }, { status: 400 });
    }
    const results = await Promise.all(payload.signals.map((s) => classifyOne(s)));
    return NextResponse.json({ results });
  }

  // Single signal.
  const result = await classifyOne({
    id: payload.id,
    title: payload.title ?? "",
    body: payload.body ?? null,
    source: payload.source ?? null,
  });
  return NextResponse.json(result);
}
