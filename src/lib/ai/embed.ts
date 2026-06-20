/**
 * Calls Gemini text-embedding-004 to generate a 768-dim embedding for text.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: { parts: [{ text }] },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini embed failed: ${res.status} ${body.slice(0, 120)}`);
  }

  const data = (await res.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}
