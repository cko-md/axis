export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: "INVALID_JSON" | "PAYLOAD_TOO_LARGE" };

/** Read JSON without allowing Request.json() to buffer an unbounded body. */
export async function readBoundedJson(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  const reader = message.body?.getReader();
  const declaredLength = Number(message.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (reader) void reader.cancel().catch(() => {});
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE" };
  }

  if (!reader) return { ok: false, status: 400, code: "INVALID_JSON" };

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE" };
      }
      chunks.push(next.value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    void reader.cancel().catch(() => {});
    return { ok: false, status: 400, code: "INVALID_JSON" };
  }
}
