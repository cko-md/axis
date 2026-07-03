import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { getGeminiApiKey } from "@/lib/env";

export const runtime = "nodejs";

// Gemini 2.5 Flash understands audio via inline_data in generateContent — the
// same model the rest of the app standardizes on (see src/lib/ai/router.ts).
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Inline audio must fit under Gemini's ~20MB request cap; we keep a safer client
// chunk size but guard here too.
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
  "audio/mp4",
]);

/**
 * Transcribes a recorded audio chunk via Gemini.
 *
 * This is the robust fallback for live transcription: Gemini Live's true
 * real-time path uses a bidirectional WebSocket session (BidiGenerateContent),
 * which Next.js route handlers cannot broker without a long-lived socket / the
 * `ws` dependency (not installed). Instead the client records short chunks and
 * POSTs each one here for near-real-time transcription, inserting the returned
 * text into the active note. See the UI control in NotesModule.tsx.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const key = getGeminiApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "Transcription requires GEMINI_API_KEY. Falling back to in-browser speech recognition." },
      { status: 503 },
    );
  }

  const { audio, mimeType } = (await req.json().catch(() => ({}))) as {
    audio?: string; // base64 (no data: prefix)
    mimeType?: string;
  };

  if (!audio) return NextResponse.json({ error: "Missing audio data" }, { status: 400 });

  const mime = (mimeType || "audio/webm").split(";")[0].trim();
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `Unsupported audio type: ${mime}` }, { status: 400 });
  }

  // Rough base64 → byte size check (4 chars ≈ 3 bytes).
  if (audio.length * 0.75 > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Audio chunk too large — record shorter segments." }, { status: 413 });
  }

  try {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "Transcribe the speech in this audio verbatim. Return ONLY the transcript text with no preamble, labels, or commentary. If there is no intelligible speech, return an empty string.",
              },
              { inlineData: { mimeType: mime, data: audio } },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!res.ok) {
      Sentry.captureException(new Error("Notes transcription provider failed"), {
        tags: { area: "notes", op: "transcribe_audio", provider: "gemini", status: String(res.status) },
      });
      return NextResponse.json(
        { error: `Transcription failed (${res.status}).` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    return NextResponse.json({ transcript });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error("Notes transcription request failed"), {
      tags: { area: "notes", op: "transcribe_audio", provider: "gemini" },
    });
    return NextResponse.json({ error: "Transcription request failed. Try again." }, { status: 502 });
  }
}
