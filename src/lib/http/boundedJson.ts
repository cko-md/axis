/** Read JSON without trusting Content-Length (which may be absent or chunked). */
export async function readBoundedJson(request: Request, maxBytes: number, deadlineMs = 5_000): Promise<unknown> {
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => rejectDeadline(new Error("body_deadline_exceeded")), deadlineMs);
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    // A hostile stream may never resolve cancel(); cleanup must not defeat the
    // body deadline. Cancellation is best-effort and intentionally detached.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("invalid_json"); }
}
