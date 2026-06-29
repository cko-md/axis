import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON } from "@/lib/ai/router";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";

type PersonTag = "mentor" | "collaborator" | "friend";
const TAGS: PersonTag[] = ["mentor", "collaborator", "friend"];

type SyncedContact = { id: string; name: string; email: string; phone: string };
type ExistingPerson = { id: string; name: string; tag: PersonTag };

type MergeSuggestion = { contactId: string; type: "merge"; matchedPersonId: string; matchedPersonName: string; confidence: number };
type AddSuggestion = { contactId: string; type: "add"; suggestedTag: PersonTag; reason: string };
type Suggestion = MergeSuggestion | AddSuggestion;

const PERSONAL_EMAIL_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "me.com"]);

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(dr|mr|mrs|ms|prof)\.?\s+/, "");
}

// Cheap heuristic for genuinely-new contacts (no AI call needed): a contact
// on a common personal-email provider is probably a friend. Everything else
// defaults to collaborator, the same default usePeople()'s addPerson uses
// for a manually-added person with no tag specified — there's no separate
// "shares my work domain" tag to distinguish, since PersonTag only has
// mentor/collaborator/friend.
function heuristicTag(contactEmail: string): PersonTag {
  const domain = contactEmail.split("@")[1]?.toLowerCase();
  if (domain && PERSONAL_EMAIL_DOMAINS.has(domain)) return "friend";
  return "collaborator";
}

async function aiMatch(
  client: Anthropic | null,
  people: ExistingPerson[],
  ambiguous: SyncedContact[],
): Promise<{ matches: Array<{ contactId: string; personId: string; confidence: number }>; tags: Array<{ contactId: string; tag: PersonTag }> }> {
  const parsed = await aiJSON<{
    matches?: Array<{ contact_id?: string; person_id?: string; confidence?: number }>;
    tags?: Array<{ contact_id?: string; tag?: string }>;
  }>({
    mode: "triage",
    anthropic: client,
    system:
      "You help dedupe a personal CRM against newly-synced contacts. Given EXISTING people and NEW contacts, " +
      "find NEW contacts that are very likely the same person as an EXISTING one (different name formatting, " +
      "nickname, title prefix, etc.) — only return matches you're genuinely confident about (confidence > 0.6). " +
      "For NEW contacts with no likely match, suggest a tag: \"mentor\", \"collaborator\", or \"friend\", based on " +
      "any signal in the name/email. " +
      'Return ONLY JSON: { "matches": [{"contact_id","person_id","confidence"}], "tags": [{"contact_id","tag"}] }. ' +
      "Every new contact should appear in exactly one of matches or tags, never both.",
    userMessage: `EXISTING:\n${people.map((p) => `${p.id}: ${p.name}`).join("\n")}\n\nNEW:\n${ambiguous.map((c) => `${c.id}: ${c.name} <${c.email}>`).join("\n")}`,
    maxTokens: 800,
  });
  return {
    matches: (parsed.matches ?? [])
      .filter((m) => typeof m.contact_id === "string" && typeof m.person_id === "string")
      .map((m) => ({ contactId: m.contact_id as string, personId: m.person_id as string, confidence: typeof m.confidence === "number" ? m.confidence : 0.6 })),
    tags: (parsed.tags ?? [])
      .filter((t) => typeof t.contact_id === "string" && TAGS.includes(t.tag as PersonTag))
      .map((t) => ({ contactId: t.contact_id as string, tag: t.tag as PersonTag })),
  };
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { success } =
    (await redisRateLimit(user.id, 30, "1 m", "axis:match-contacts")) ??
    memoryRateLimit(`match-contacts:${user.id}`, 30, 60_000);
  if (!success) return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });

  let body: { contacts?: SyncedContact[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contacts = Array.isArray(body.contacts) ? body.contacts.filter((c) => c && typeof c.id === "string" && c.name) : [];
  if (contacts.length === 0) return NextResponse.json({ suggestions: [] });

  const { data: peopleRows } = await supabase.from("people").select("id, name, tag").eq("user_id", user.id);
  const people = (peopleRows ?? []) as ExistingPerson[];
  const peopleByNormName = new Map(people.map((p) => [normalizeName(p.name), p]));

  const suggestions: Suggestion[] = [];
  const ambiguous: SyncedContact[] = [];

  for (const contact of contacts) {
    const exact = peopleByNormName.get(normalizeName(contact.name));
    if (exact) {
      suggestions.push({ contactId: contact.id, type: "merge", matchedPersonId: exact.id, matchedPersonName: exact.name, confidence: 1 });
    } else {
      ambiguous.push(contact);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  if (ambiguous.length > 0 && people.length > 0 && (client || hasGemini)) {
    try {
      const { matches, tags } = await aiMatch(client, people, ambiguous);
      const matchedIds = new Set<string>();
      for (const m of matches) {
        const person = people.find((p) => p.id === m.personId);
        if (!person) continue;
        suggestions.push({ contactId: m.contactId, type: "merge", matchedPersonId: person.id, matchedPersonName: person.name, confidence: m.confidence });
        matchedIds.add(m.contactId);
      }
      const tagByContact = new Map(tags.map((t) => [t.contactId, t.tag]));
      for (const contact of ambiguous) {
        if (matchedIds.has(contact.id)) continue;
        const tag = tagByContact.get(contact.id) ?? heuristicTag(contact.email);
        suggestions.push({ contactId: contact.id, type: "add", suggestedTag: tag, reason: tagByContact.has(contact.id) ? "AI suggestion" : "Heuristic match" });
      }
    } catch {
      for (const contact of ambiguous) {
        suggestions.push({ contactId: contact.id, type: "add", suggestedTag: heuristicTag(contact.email), reason: "Heuristic match" });
      }
    }
  } else {
    for (const contact of ambiguous) {
      suggestions.push({ contactId: contact.id, type: "add", suggestedTag: heuristicTag(contact.email), reason: "Heuristic match" });
    }
  }

  return NextResponse.json({ suggestions });
}
