import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";
import { seededIndex } from "@/lib/content/daily";
import { CURATED_POEMS, FALLBACK_POEMS, type PoemPayload } from "@/lib/content/poems";

type PoetryDbPoem = {
  title: string;
  author: string;
  lines: string[];
};

const MAX_POEM_LINES = 1_000;
const MAX_POEM_LINE_LENGTH = 5_000;
const MAX_POEM_METADATA_LENGTH = 500;
const MAX_POETRYDB_BODY_BYTES = 256 * 1_024;
const MAX_POETRYDB_RESULTS = 25;

class PoetryDbHttpError extends Error {
  constructor(readonly status: number) {
    super("PoetryDB request failed");
    this.name = "PoetryDbHttpError";
  }
}

class PoetryDbPayloadError extends Error {
  constructor() {
    super("PoetryDB response was invalid");
    this.name = "PoetryDbPayloadError";
  }
}

function fallbackFailure(error: unknown) {
  if (error instanceof PoetryDbHttpError) {
    return {
      code: error.status === 404
        ? "not_found"
        : error.status === 429
          ? "rate_limited"
          : "provider_error",
      status: error.status,
      expected: error.status < 500,
    } as const;
  }
  if (error instanceof PoetryDbPayloadError || error instanceof SyntaxError) {
    return { code: "INVALID_RESPONSE", expected: false } as const;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "PROVIDER_TIMEOUT", status: 504, expected: false } as const;
  }
  if (error instanceof TypeError) {
    return { code: "network", expected: false } as const;
  }
  return { code: "provider_error", expected: false } as const;
}

function isPoetryDbPoem(value: unknown): value is PoetryDbPoem {
  if (!value || typeof value !== "object") return false;
  const poem = value as Partial<PoetryDbPoem>;
  return typeof poem.title === "string"
    && poem.title.trim().length > 0
    && poem.title.length <= MAX_POEM_METADATA_LENGTH
    && typeof poem.author === "string"
    && poem.author.trim().length > 0
    && poem.author.length <= MAX_POEM_METADATA_LENGTH
    && Array.isArray(poem.lines)
    && poem.lines.length > 0
    && poem.lines.length <= MAX_POEM_LINES
    && poem.lines.every((line) => typeof line === "string" && line.length <= MAX_POEM_LINE_LENGTH);
}

function requestedSeed(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("seed");
  if (raw !== null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return Math.floor(Date.now() / 86_400_000);
}

async function readBoundedPoetryDbJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength)
      || parsedLength < 0
      || parsedLength > MAX_POETRYDB_BODY_BYTES
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // The route-owned normalized provider event below remains authoritative.
      }
      throw new PoetryDbPayloadError();
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PoetryDbPayloadError();

  const decoder = new TextDecoder();
  let text = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_POETRYDB_BODY_BYTES) {
        await reader.cancel();
        throw new PoetryDbPayloadError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  if (text.includes("\uFFFD")) throw new PoetryDbPayloadError();
  return JSON.parse(text) as unknown;
}

// Mirrors /api/widgets/art: a seed (the client's local day number, or any
// offset the "Next" button advances to) deterministically picks one entry
// from the curated public-domain corpus. Same seed, same poem — no re-roll
// on refresh. PoetryDB outages degrade to a bundled poem instead of an
// empty card; the fallback pick is salted so it doesn't shadow the curated
// rotation's ordering.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const seed = requestedSeed(req);
  const pick = CURATED_POEMS[seededIndex(seed, CURATED_POEMS.length)];

  try {
    const url = `https://poetrydb.org/author,title/${encodeURIComponent(pick.author)};${encodeURIComponent(pick.title)}:abs/title,author,lines`;
    const res = await timedProviderFetch(
      url,
      { next: { revalidate: 3600 } },
      {
        area: "console",
        provider: "poetrydb",
        operation: "poem_fetch",
        timeoutMs: 5_000,
        slowMs: 1_500,
        // A valid bundled public-domain poem is the completed workflow, not an
        // application failure. timedProviderFetch still records safe timing;
        // this route emits the single fallback breadcrumb below.
        captureFailures: false,
        recordBreadcrumbs: false,
      },
    );
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // Preserve the upstream status as the normalized failure classification.
      }
      throw new PoetryDbHttpError(res.status);
    }

    const json = await readBoundedPoetryDbJson(res);
    if (
      json
      && typeof json === "object"
      && !Array.isArray(json)
      && "status" in json
      && typeof json.status === "number"
      && Number.isInteger(json.status)
      && json.status >= 400
      && json.status <= 599
    ) {
      throw new PoetryDbHttpError(json.status);
    }
    if (
      !Array.isArray(json)
      || json.length === 0
      || json.length > MAX_POETRYDB_RESULTS
    ) throw new PoetryDbPayloadError();

    // Ambiguous titles can match more than one poem; the shortest fits the card.
    const poem = json.filter(isPoetryDbPoem).sort((a, b) => a.lines.length - b.lines.length)[0];
    if (!poem) throw new PoetryDbPayloadError();

    const payload: PoemPayload = {
      title: poem.title,
      author: poem.author,
      lines: poem.lines,
      source: "poetrydb",
    };
    logRouteTiming("/api/widgets/poem", routeStartedAt, { fallback: false });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    const failure = fallbackFailure(error);
    const telemetry = {
      area: "console",
      provider: "poetrydb",
      operation: "poem_fetch",
      code: failure.code,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      outcome: "degraded",
      fallback: true,
    };
    const fallback = FALLBACK_POEMS[seededIndex(seed, FALLBACK_POEMS.length, 1)];
    Sentry.addBreadcrumb({
      category: "provider.fallback",
      level: failure.expected ? "info" : "warning",
      message: "poetrydb.poem_fetch",
      data: telemetry,
    });
    const captureContext = {
      tags: {
        area: "console",
        provider: "poetrydb",
        operation: "poem_fetch",
        code: failure.code,
        ...(failure.status !== undefined ? { status: String(failure.status) } : {}),
        outcome: "degraded",
        fallback: "true",
      },
      contexts: { providerCall: telemetry },
    };
    if (failure.expected) {
      Sentry.captureMessage("poetrydb poem_fetch degraded", {
        ...captureContext,
        level: "info",
      });
    } else {
      Sentry.captureException(new Error(`poetrydb poem_fetch failed: ${failure.code}`), captureContext);
    }
    logRouteTiming("/api/widgets/poem", routeStartedAt, { fallback: true });
    // Still a 200: the card shows a real poem either way, just from the
    // bundled corpus, and the shorter cache window retries the provider soon.
    return NextResponse.json(fallback, {
      headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" },
    });
  }
}
