import { optionalEnv } from "@/lib/env";

/**
 * Calls Gemini gemini-embedding-001 to generate a 768-dim embedding for text.
 * Truncated to 768 dims (the model's native output is 3072) via
 * outputDimensionality to match the note_embeddings.embedding vector(768)
 * column and its HNSW index — text-embedding-004, the model this previously
 * called, has been retired and 404s.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey =
    optionalEnv("GEMINI_API_KEY") ?? optionalEnv("GOOGLE_GENERATIVE_AI_API_KEY") ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini embed failed: ${res.status}`);
  }

  const data = (await res.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}
