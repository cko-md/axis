import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** Codes are deliberately URL- and hostname-free: callers may safely expose them. */
export type SafeFetchErrorCode =
  | "SAFE_FETCH_INVALID_URL"
  | "SAFE_FETCH_BLOCKED_HOST"
  | "SAFE_FETCH_DNS_FAILED"
  | "SAFE_FETCH_BLOCKED_ADDRESS"
  | "SAFE_FETCH_INVALID_REDIRECT"
  | "SAFE_FETCH_TOO_MANY_REDIRECTS"
  | "SAFE_FETCH_TIMEOUT"
  | "SAFE_FETCH_BODY_TOO_LARGE"
  | "SAFE_FETCH_ABORTED"
  | "SAFE_FETCH_TRANSPORT_FAILED";

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode) {
    super(code);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  headers?: HeadersInit;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
  /** Exact hosts permitted for every hop (for provider-derived secondary URLs). */
  allowedHosts?: readonly string[];
};

type ResolvedAddress = { address: string; family: number };
type Transport = (url: URL, input: {
  headers: HeadersInit | undefined;
  timeoutMs: number;
  maxBodyBytes: number;
  address: ResolvedAddress;
  signal?: AbortSignal;
}) => Promise<Response>;

/** Test seams only; production always resolves and pins each requested hop. */
export type SafeFetchDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: Transport;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const OAUTH_HOSTS = new Set([
  "accounts.google.com", "login.microsoftonline.com", "login.live.com",
  "accounts.spotify.com", "appleid.apple.com", "www.strava.com", "github.com",
]);

function bareHost(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function isBlockedHost(hostname: string) {
  const host = bareHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host === "metadata.google.internal"
    || [...OAUTH_HOSTS].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some((part) => part > 255) ? null : octets;
}

function isBlockedIPv4(address: string) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c, d] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0 && (d <= 8 || d === 170 || d === 171))
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    || (a === 203 && b === 0 && c === 113);
}

type Ipv6Cidr = { bits: number; words: number[] };

const IPV6_BLOCKED_CIDRS: readonly Ipv6Cidr[] = [
  // special/compatible/mapped, NAT64 well-known/local-use, discard-only
  { bits: 96, words: [0, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 96, words: [0, 0, 0, 0, 0, 0xffff, 0, 0] },
  { bits: 96, words: [0x64, 0xff9b, 0, 0, 0, 0, 0, 0] },
  { bits: 48, words: [0x64, 0xff9b, 1, 0, 0, 0, 0, 0] },
  { bits: 64, words: [0x100, 0, 0, 0, 0, 0, 0, 0] },
  // Teredo, benchmarking, Orchid, documentation, 6to4, and retired 6bone.
  { bits: 32, words: [0x2001, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 48, words: [0x2001, 2, 0, 0, 0, 0, 0, 0] },
  { bits: 28, words: [0x2001, 0x10, 0, 0, 0, 0, 0, 0] },
  { bits: 28, words: [0x2001, 0x20, 0, 0, 0, 0, 0, 0] },
  { bits: 32, words: [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0] },
  { bits: 16, words: [0x2002, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 16, words: [0x3ffe, 0, 0, 0, 0, 0, 0, 0] },
];

function matchesIpv6Cidr(words: number[], cidr: Ipv6Cidr) {
  let remaining = cidr.bits;
  for (let index = 0; remaining > 0; index += 1) {
    const compared = Math.min(16, remaining);
    const mask = compared === 16 ? 0xffff : (0xffff << (16 - compared)) & 0xffff;
    if ((words[index] & mask) !== (cidr.words[index] & mask)) return false;
    remaining -= compared;
  }
  return true;
}

function isBlockedIPv6(address: string) {
  const words = ipv6Words(address);
  if (!words) return true;
  const embeddedV4 = (start: number) =>
    `${words[start] >> 8}.${words[start] & 0xff}.${words[start + 1] >> 8}.${words[start + 1] & 0xff}`;
  const allZero = (endExclusive: number) => words.slice(0, endExclusive).every((word) => word === 0);
  // IPv4-compatible and IPv4-mapped addresses can arrive from DNS as hex
  // words (e.g. ::ffff:7f00:1), not dotted text. Treat both representations
  // exactly like their embedded IPv4 address.
  if (allZero(6)) return isBlockedIPv4(embeddedV4(6));
  if (allZero(5) && words[5] === 0xffff) return isBlockedIPv4(embeddedV4(6));
  // Deny every non-global-unicast address, then carve the globally-routed
  // special-purpose CIDRs above out as well. This word/CIDR table avoids the
  // textual-prefix bypasses that occur when Node canonicalizes IPv6 literals.
  if ((words[0] & 0xe000) !== 0x2000) return true;
  return IPV6_BLOCKED_CIDRS.some((cidr) => matchesIpv6Cidr(words, cidr));
}

function ipv6Words(address: string): number[] | null {
  const raw = address.toLowerCase();
  if (raw.includes("%") || raw.split("::").length > 2) return null;
  const [leftRaw, rightRaw] = raw.split("::");
  const toWords = (part: string): number[] | null => {
    if (!part) return [];
    const pieces = part.split(":");
    const words: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const octets = ipv4Octets(piece);
        if (!octets) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        words.push(Number.parseInt(piece, 16));
      } else return null;
    }
    return words;
  };
  const left = toWords(leftRaw);
  const right = toWords(rightRaw ?? "");
  if (!left || !right) return null;
  if (!raw.includes("::")) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

export function isBlockedAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

/** HTTP status mapping shared by user-facing safe-fetch routes. */
export function safeFetchHttpStatus(error: unknown) {
  if (!(error instanceof SafeFetchError)) return 502;
  if (error.code === "SAFE_FETCH_INVALID_URL") return 400;
  if (error.code === "SAFE_FETCH_BODY_TOO_LARGE") return 413;
  if (error.code === "SAFE_FETCH_TIMEOUT") return 504;
  if (error.code === "SAFE_FETCH_BLOCKED_HOST" || error.code === "SAFE_FETCH_BLOCKED_ADDRESS") return 403;
  return 502;
}

function parseUrl(raw: string | URL, allowedHosts?: readonly string[]) {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  } catch {
    throw new SafeFetchError("SAFE_FETCH_INVALID_URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SafeFetchError("SAFE_FETCH_INVALID_URL");
  }
  const hostname = bareHost(url.hostname);
  if (isBlockedHost(hostname)) throw new SafeFetchError("SAFE_FETCH_BLOCKED_HOST");
  if (allowedHosts && !allowedHosts.some((host) => hostname === bareHost(host))) {
    throw new SafeFetchError("SAFE_FETCH_BLOCKED_HOST");
  }
  return url;
}

async function resolvePublicAddress(url: URL, resolve: NonNullable<SafeFetchDependencies["resolve"]>) {
  const hostname = bareHost(url.hostname);
  const literalFamily = isIP(hostname);
  let answers: ResolvedAddress[];
  try {
    answers = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolve(hostname);
  } catch {
    throw new SafeFetchError("SAFE_FETCH_DNS_FAILED");
  }
  if (!answers.length) throw new SafeFetchError("SAFE_FETCH_DNS_FAILED");
  // Reject the whole answer set: selecting only a public answer makes mixed-DNS
  // names a rebinding primitive and silently changes routing between attempts.
  if (answers.some((answer) => isBlockedAddress(answer.address))) {
    throw new SafeFetchError("SAFE_FETCH_BLOCKED_ADDRESS");
  }
  return answers[0];
}

function responseWithUrl(response: Response, url: URL) {
  Object.defineProperty(response, "url", { value: url.href, configurable: true });
  return response;
}

function sanitizedHeaders(input: HeadersInit | undefined): HeadersInit | undefined {
  if (!input) return undefined;
  const headers = new Headers(input);
  // This boundary serves untrusted public resources. Permit only rendering
  // negotiation headers; credentials and opaque tracing never cross any hop.
  const allowed = new Headers();
  for (const name of ["accept", "accept-language", "user-agent"]) {
    const value = headers.get(name);
    if (value) allowed.set(name, value);
  }
  return allowed;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SafeFetchError("SAFE_FETCH_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

export const pinnedSafeFetchTransport: Transport = (url, input) => new Promise((resolve, reject) => {
  let settled = false;
  const control: { deadlineTimer?: ReturnType<typeof setTimeout> } = {};
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (control.deadlineTimer) clearTimeout(control.deadlineTimer);
    input.signal?.removeEventListener("abort", abort);
    fn();
  };
  const client = url.protocol === "https:" ? https : http;
  // Dial the validated IP directly instead of asking Node's HTTP agent to look
  // it up again. Retain the original Host/SNI identity so virtual hosts and
  // HTTPS certificate validation behave like the validated URL.
  const pinnedAddress = input.address.address;
  // Do not rewrite URL.hostname here. In particular, assigning a raw IPv6
  // literal to URL.hostname produces a malformed authority on supported Node
  // versions. Explicit request options also make the no-second-lookup
  // guarantee inspectable: the socket destination is the checked address,
  // while Host and SNI retain the original URL identity.
  const request = client.request({
    protocol: url.protocol,
    hostname: pinnedAddress,
    family: input.address.family,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { ...Object.fromEntries(new Headers(input.headers).entries()), host: url.host },
    servername: url.hostname,
  }, (upstream) => {
    const contentLength = Number(upstream.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > input.maxBodyBytes) {
      request.destroy();
      settle(() => reject(new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE")));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    upstream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > input.maxBodyBytes) {
        upstream.destroy(new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    upstream.on("error", (error) => settle(() => reject(error)));
    upstream.on("end", () => settle(() => resolve(responseWithUrl(new Response(Buffer.concat(chunks), {
      status: upstream.statusCode ?? 502,
      statusText: upstream.statusMessage,
      headers: upstream.headers as HeadersInit,
    }), url))));
  });
  request.setTimeout(input.timeoutMs, () => request.destroy(new SafeFetchError("SAFE_FETCH_TIMEOUT")));
  // `request.setTimeout` is an inactivity timeout; retain a total deadline so
  // a peer dribbling bytes cannot keep a request alive indefinitely.
  control.deadlineTimer = setTimeout(() => request.destroy(new SafeFetchError("SAFE_FETCH_TIMEOUT")), input.timeoutMs);
  const abort = () => request.destroy(new SafeFetchError("SAFE_FETCH_ABORTED"));
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  request.on("error", (error) => settle(() => reject(error)));
  request.end();
});

/**
 * Fetches a user-controlled HTTP(S) URL through a DNS-pinned, redirect-manual
 * boundary. It is intentionally GET-only: AXIS must not use this helper for
 * provider mutations or any request carrying credentials/body data.
 */
export async function safeFetch(raw: string | URL, options: SafeFetchOptions = {}, dependencies: SafeFetchDependencies = {}) {
  const resolve = dependencies.resolve ?? defaultResolve;
  const transport = dependencies.transport ?? pinnedSafeFetchTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new SafeFetchError("SAFE_FETCH_INVALID_URL");

  let url = parseUrl(raw, options.allowedHosts);
  const headers = sanitizedHeaders(options.headers);
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("SAFE_FETCH_TIMEOUT");
    const address = await within(resolvePublicAddress(url, resolve), remaining);
    let response: Response;
    try {
      response = await transport(url, { headers, timeoutMs: remaining, maxBodyBytes, address, signal: options.signal });
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError(options.signal?.aborted ? "SAFE_FETCH_ABORTED" : "SAFE_FETCH_TRANSPORT_FAILED");
    }
    responseWithUrl(response, url);
    const advertisedLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBodyBytes) {
      throw new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE");
    }
    if (response.status < 300 || response.status > 399) return response;
    if (redirects === maxRedirects) throw new SafeFetchError("SAFE_FETCH_TOO_MANY_REDIRECTS");
    const location = response.headers.get("location");
    if (!location) throw new SafeFetchError("SAFE_FETCH_INVALID_REDIRECT");
    try {
      url = parseUrl(new URL(location, url), options.allowedHosts);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError("SAFE_FETCH_INVALID_REDIRECT");
    }
  }
  throw new SafeFetchError("SAFE_FETCH_TOO_MANY_REDIRECTS");
}
