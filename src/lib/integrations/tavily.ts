/**
 * Shared server-side Tavily client.
 *
 * Wraps the Tavily REST API (https://docs.tavily.com). The primary use case is
 * the Extract endpoint, which returns clean readable content (markdown) from a
 * URL — used as the WebViewer "reader view" fallback when a page refuses to be
 * embedded in an iframe (X-Frame-Options / frame-ancestors CSP) or is a PDF.
 *
 * The Search endpoint is also exposed for reuse by other server code.
 *
 * Keep this module server-only: it reads TAVILY_API_KEY from the environment
 * and must never be imported into a client component.
 */

const TAVILY_BASE = "https://api.tavily.com";

export type TavilyExtractDepth = "basic" | "advanced";
export type TavilyExtractFormat = "markdown" | "text";

export interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

export interface TavilyExtractFailure {
  url: string;
  error: string;
}

export interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: TavilyExtractFailure[];
  response_time?: number;
  request_id?: string;
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time?: number;
  request_id?: string;
}

export class TavilyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TavilyError";
    this.status = status;
  }
}

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new TavilyError("TAVILY_API_KEY is not configured", 503);
  return key;
}

async function tavilyFetch<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${TAVILY_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Tavily request failed";
    throw new TavilyError(msg, 502);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new TavilyError(`Tavily ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
  }

  return (await res.json()) as T;
}

export interface ExtractOptions {
  extractDepth?: TavilyExtractDepth;
  format?: TavilyExtractFormat;
  includeImages?: boolean;
  /** Per-request Tavily-side timeout (seconds, 1–60). */
  timeout?: number;
  /** Client-side fetch abort timeout (ms). */
  fetchTimeoutMs?: number;
}

/**
 * Extract clean readable content from one or more URLs.
 * Returns the raw Tavily response (results + failed_results).
 */
export async function tavilyExtract(
  urls: string | string[],
  opts: ExtractOptions = {},
): Promise<TavilyExtractResponse> {
  const {
    extractDepth = "advanced",
    format = "markdown",
    includeImages = false,
    timeout = 30,
    fetchTimeoutMs = 35_000,
  } = opts;

  return tavilyFetch<TavilyExtractResponse>(
    "/extract",
    {
      urls,
      extract_depth: extractDepth,
      format,
      include_images: includeImages,
      timeout,
    },
    fetchTimeoutMs,
  );
}

/**
 * Convenience wrapper: extract a single URL and return the first successful
 * result, or throw a TavilyError describing the failure.
 */
export async function tavilyExtractOne(
  url: string,
  opts: ExtractOptions = {},
): Promise<TavilyExtractResult> {
  const data = await tavilyExtract(url, opts);
  const hit = data.results?.[0];
  if (hit?.raw_content) return hit;
  const failure = data.failed_results?.[0];
  throw new TavilyError(failure?.error ?? "Tavily returned no readable content", 422);
}

export interface SearchOptions {
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  fetchTimeoutMs?: number;
}

/** Run a Tavily web search. Exposed for reuse beyond the WebViewer reader. */
export async function tavilySearch(
  query: string,
  opts: SearchOptions = {},
): Promise<TavilySearchResponse> {
  const {
    searchDepth = "basic",
    maxResults = 5,
    includeAnswer = false,
    includeRawContent = false,
    fetchTimeoutMs = 20_000,
  } = opts;

  return tavilyFetch<TavilySearchResponse>(
    "/search",
    {
      query,
      search_depth: searchDepth,
      max_results: maxResults,
      include_answer: includeAnswer,
      include_raw_content: includeRawContent,
    },
    fetchTimeoutMs,
  );
}
