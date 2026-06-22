import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiGenerate, type AIProviderPref } from "@/lib/ai/router";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Browser-ish UA — YouTube serves a different (often caption-stripped) page to
// obvious bots. This is best-effort; YouTube changes its surface frequently.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type CaptionTrack = { baseUrl: string; languageCode?: string; kind?: string; vssId?: string };

/** Extract an 11-char YouTube video id from any common URL shape (or a bare id). */
function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  // youtu.be/<id>, /watch?v=<id>, /embed/<id>, /shorts/<id>, /live/<id>
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Decode XML / HTML entities found in YouTube caption payloads. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Pull the ytInitialPlayerResponse JSON out of the watch-page HTML. */
function parsePlayerResponse(html: string): unknown | null {
  const m =
    html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var|const|let|<\/script>)/) ||
    html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function captionTracksFrom(player: unknown): CaptionTrack[] {
  const tracks = (player as {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  })?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

function videoTitleFrom(player: unknown): string {
  return (
    (player as { videoDetails?: { title?: string } })?.videoDetails?.title || "YouTube video"
  );
}

/** Prefer an English track, then any manual track, then anything. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks.length) return null;
  const en = tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr");
  const anyEn = tracks.find((t) => t.languageCode?.startsWith("en"));
  const manual = tracks.find((t) => t.kind !== "asr");
  return en || anyEn || manual || tracks[0];
}

/** Fetch a caption track and flatten it to plain text. Handles XML + JSON3. */
async function fetchTranscript(baseUrl: string): Promise<string> {
  // Ask for the json3 format — easier and more robust than the legacy XML.
  const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`caption fetch ${res.status}`);
  const text = await res.text();

  // JSON3 shape: { events: [{ segs: [{ utf8 }] }] }
  if (text.trim().startsWith("{")) {
    try {
      const data = JSON.parse(text) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
      const parts = (data.events ?? [])
        .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""))
        .join("");
      return parts.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    } catch {
      /* fall through to XML parse */
    }
  }

  // Legacy XML shape: <text start="..">escaped text</text>
  const segs = [...text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, " ")),
  );
  return segs.join(" ").replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { url } = (await req.json().catch(() => ({}))) as { url?: string };
  if (!url) return NextResponse.json({ error: "Missing YouTube URL" }, { status: 400 });

  const videoId = extractVideoId(url);
  if (!videoId) {
    return NextResponse.json({ error: "Could not parse a YouTube video id from that URL." }, { status: 400 });
  }

  // ── 1. Fetch the watch page + player response ───────────────────────────────
  let player: unknown | null = null;
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (pageRes.ok) {
      player = parsePlayerResponse(await pageRes.text());
    }
  } catch {
    /* network error handled below */
  }

  if (!player) {
    return NextResponse.json(
      { error: "Could not load the video page. The video may be private, age-restricted, or unavailable." },
      { status: 502 },
    );
  }

  // ── 2. Locate + fetch a transcript ──────────────────────────────────────────
  const track = pickTrack(captionTracksFrom(player));
  if (!track?.baseUrl) {
    return NextResponse.json(
      { error: "No transcript/captions are available for this video." },
      { status: 422 },
    );
  }

  let transcript = "";
  try {
    transcript = await fetchTranscript(track.baseUrl);
  } catch {
    return NextResponse.json(
      { error: "Found captions but could not download them. Try again later." },
      { status: 502 },
    );
  }

  if (!transcript || transcript.length < 20) {
    return NextResponse.json({ error: "The transcript for this video was empty." }, { status: 422 });
  }

  const videoTitle = videoTitleFrom(player);

  // ── 3. Turn the transcript into structured study notes ──────────────────────
  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle();
  const providerPref = (profile?.ai_provider as AIProviderPref) ?? "auto";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  let bodyHtml: string;
  try {
    const { text: notes } = await aiGenerate({
      mode: "notes-summarize", // reuse a notes-eligible routing mode
      anthropic,
      providerPref,
      system:
        "You are a study-note generator. Given a raw video transcript (rough machine captions), produce clean, well-structured study notes in Markdown: a short overview paragraph, then thematic sections with '## ' headings and concise bullet points capturing key facts, definitions, and takeaways. Do not invent content. Return only the Markdown, no preamble.",
      userMessage: `Video title: ${videoTitle}\n\nTranscript:\n${transcript.slice(0, 14000)}`,
      maxTokens: 1800,
    });
    bodyHtml = markdownishToHtml(notes);
  } catch {
    // AI unavailable — still create a useful note from the raw transcript.
    bodyHtml = `<p><em>Transcript imported (AI structuring unavailable):</em></p><p>${escapeHtml(
      transcript.slice(0, 14000),
    )}</p>`;
  }

  // ── 4. Persist as a new note tagged with the source video id ────────────────
  const header = `<h1>${escapeHtml(videoTitle)}</h1><p><a href="https://www.youtube.com/watch?v=${videoId}">Source: youtube.com/watch?v=${videoId}</a></p>`;
  const { data: note, error: insertError } = await supabase
    .from("notes")
    .insert({
      user_id: user.id,
      title: videoTitle.slice(0, 200),
      body: `${header}${bodyHtml}`,
      folder: "Research",
      tags: [`youtube-source:${videoId}`],
    })
    .select()
    .single();

  if (insertError || !note) {
    return NextResponse.json({ error: "Generated notes but could not save them." }, { status: 500 });
  }

  return NextResponse.json({ note, videoId, title: videoTitle });
}

// ── tiny helpers ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Minimal Markdown → HTML for headings + bullets, enough for the Tiptap body. */
function markdownishToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(b[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}
