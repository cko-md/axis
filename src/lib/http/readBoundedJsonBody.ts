export type BoundedJsonBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: "BODY_TOO_LARGE" | "INVALID_BODY"; status: 400 | 413 };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Streams and parses one bounded JSON object without buffering an unlimited body. */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = 16_384,
  deadlineMs = 5_000,
): Promise<BoundedJsonBody> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    return { ok: false, error: "INVALID_BODY", status: 400 };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return { ok: false, error: "INVALID_BODY", status: 400 };
    }
    if (declared > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      return { ok: false, error: "BODY_TOO_LARGE", status: 413 };
    }
  }
  if (!request.body) return { ok: false, error: "INVALID_BODY", status: 400 };
  const reader = request.body.getReader();
  const deadlineSignal = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([request.signal, deadlineSignal]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Body read aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(new DOMException("Body read aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, error: "BODY_TOO_LARGE", status: 413 };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    return isPlainRecord(value)
      ? { ok: true, value }
      : { ok: false, error: "INVALID_BODY", status: 400 };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, error: "INVALID_BODY", status: 400 };
  }
}
