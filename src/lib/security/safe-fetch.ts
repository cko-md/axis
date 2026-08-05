import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https, { type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import { type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

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
  /**
   * Validate response status and headers, then immediately close the upstream
   * body. This is intentionally narrow: it is for metadata validation only
   * and must never become the default for callers that consume a body.
   */
  responseBodyMode?: "buffer" | "discard";
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
  discardBody?: boolean;
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

type Ipv4Cidr = { bits: number; octets: readonly [number, number, number, number] };

function matchesIpv4Cidr(octets: number[], cidr: Ipv4Cidr) {
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const network = ((cidr.octets[0] << 24) | (cidr.octets[1] << 16) | (cidr.octets[2] << 8) | cidr.octets[3]) >>> 0;
  const mask = cidr.bits === 0 ? 0 : (0xffffffff << (32 - cidr.bits)) >>> 0;
  return (value & mask) === (network & mask);
}

// IANA IPv4 Special-Purpose Address Registry, snapshot 2025-10-09:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// More-specific globally reachable entries must win over a non-global parent.
const IPV4_IANA_GLOBAL_EXCEPTIONS: readonly Ipv4Cidr[] = [
  { bits: 32, octets: [192, 0, 0, 9] }, // PCP anycast
  { bits: 32, octets: [192, 0, 0, 10] }, // TURN anycast
  { bits: 24, octets: [192, 31, 196, 0] }, // AS112-v4
  { bits: 24, octets: [192, 52, 193, 0] }, // AMT
  { bits: 24, octets: [192, 175, 48, 0] }, // Direct Delegation AS112
];

const IPV4_NON_GLOBAL_CIDRS: readonly Ipv4Cidr[] = [
  { bits: 8, octets: [0, 0, 0, 0] },
  { bits: 8, octets: [10, 0, 0, 0] },
  { bits: 10, octets: [100, 64, 0, 0] },
  { bits: 8, octets: [127, 0, 0, 0] },
  { bits: 16, octets: [169, 254, 0, 0] },
  { bits: 12, octets: [172, 16, 0, 0] },
  { bits: 24, octets: [192, 0, 0, 0] },
  { bits: 24, octets: [192, 0, 2, 0] },
  { bits: 24, octets: [192, 88, 99, 0] },
  { bits: 16, octets: [192, 168, 0, 0] },
  { bits: 15, octets: [198, 18, 0, 0] },
  { bits: 24, octets: [198, 51, 100, 0] },
  { bits: 24, octets: [203, 0, 113, 0] },
  // IPv4 multicast plus the IANA reserved/limited-broadcast tail.
  { bits: 4, octets: [224, 0, 0, 0] },
  { bits: 4, octets: [240, 0, 0, 0] },
];

function isBlockedIPv4(address: string) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  if (IPV4_IANA_GLOBAL_EXCEPTIONS.some((cidr) => matchesIpv4Cidr(octets, cidr))) return false;
  return IPV4_NON_GLOBAL_CIDRS.some((cidr) => matchesIpv4Cidr(octets, cidr));
}

type Ipv6Cidr = { bits: number; words: number[] };

// IANA IPv6 Special-Purpose Address Registry, snapshot 2025-10-09:
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// These globally reachable, more-specific assignments override 2001::/23.
const IPV6_IANA_GLOBAL_EXCEPTIONS: readonly Ipv6Cidr[] = [
  { bits: 128, words: [0x2001, 1, 0, 0, 0, 0, 0, 1] }, // PCP anycast
  { bits: 128, words: [0x2001, 1, 0, 0, 0, 0, 0, 2] }, // TURN anycast
  { bits: 128, words: [0x2001, 1, 0, 0, 0, 0, 0, 3] }, // DNS-SD anycast
  { bits: 32, words: [0x2001, 3, 0, 0, 0, 0, 0, 0] }, // AMT
  { bits: 48, words: [0x2001, 4, 0x112, 0, 0, 0, 0, 0] }, // AS112-v6
  { bits: 28, words: [0x2001, 0x20, 0, 0, 0, 0, 0, 0] }, // ORCHIDv2
  { bits: 28, words: [0x2001, 0x30, 0, 0, 0, 0, 0, 0] }, // Drone DETs
];

const IPV6_NON_GLOBAL_CIDRS: readonly Ipv6Cidr[] = [
  // Unspecified/compatible/mapped, local-use NAT64, discard, and dummy.
  { bits: 96, words: [0, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 96, words: [0, 0, 0, 0, 0, 0xffff, 0, 0] },
  { bits: 48, words: [0x64, 0xff9b, 1, 0, 0, 0, 0, 0] },
  { bits: 64, words: [0x100, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 64, words: [0x100, 0, 0, 1, 0, 0, 0, 0] },
  // IETF assignments are non-global unless a more-specific exception above
  // says otherwise. This covers Teredo, benchmarking, and unassigned children.
  { bits: 23, words: [0x2001, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 28, words: [0x2001, 0x10, 0, 0, 0, 0, 0, 0] },
  { bits: 32, words: [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0] },
  { bits: 16, words: [0x2002, 0, 0, 0, 0, 0, 0, 0] },
  // Returned 6bone space and current documentation space.
  { bits: 16, words: [0x3ffe, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 20, words: [0x3fff, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 16, words: [0x5f00, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 7, words: [0xfc00, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 10, words: [0xfe80, 0, 0, 0, 0, 0, 0, 0] },
];

// IANA IPv6 Global Unicast Address Assignments, snapshot 2025-10-10:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
// Fail closed for the rest of 2000::/3 because IANA marks it reserved for
// future allocation. Broader entries below subsume their later child entries.
const IPV6_ALLOCATED_GLOBAL_CIDRS: readonly Ipv6Cidr[] = [
  { bits: 23, words: [0x2001, 0x200, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x400, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x600, 0, 0, 0, 0, 0, 0] },
  { bits: 22, words: [0x2001, 0x800, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0xc00, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0xe00, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x1200, 0, 0, 0, 0, 0, 0] },
  { bits: 22, words: [0x2001, 0x1400, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x1800, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x1a00, 0, 0, 0, 0, 0, 0] },
  { bits: 22, words: [0x2001, 0x1c00, 0, 0, 0, 0, 0, 0] },
  { bits: 19, words: [0x2001, 0x2000, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4000, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4200, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4400, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4600, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4800, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4a00, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2001, 0x4c00, 0, 0, 0, 0, 0, 0] },
  { bits: 20, words: [0x2001, 0x5000, 0, 0, 0, 0, 0, 0] },
  { bits: 19, words: [0x2001, 0x8000, 0, 0, 0, 0, 0, 0] },
  { bits: 20, words: [0x2001, 0xa000, 0, 0, 0, 0, 0, 0] },
  { bits: 20, words: [0x2001, 0xb000, 0, 0, 0, 0, 0, 0] },
  { bits: 18, words: [0x2003, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2400, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2410, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2600, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2610, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 23, words: [0x2620, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2630, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2800, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2a00, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2a10, 0, 0, 0, 0, 0, 0, 0] },
  { bits: 12, words: [0x2c00, 0, 0, 0, 0, 0, 0, 0] },
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
  // words (e.g. ::ffff:7f00:1), not dotted text. IANA marks both parent
  // prefixes non-global/reserved-by-protocol, so reject them regardless of
  // whether their embedded IPv4 value would otherwise be public.
  if (allZero(6)) return true;
  if (allZero(5) && words[5] === 0xffff) return true;
  // The well-known NAT64 prefix is globally reachable, but its embedded target
  // still must pass the IPv4 policy or it becomes an IPv4 SSRF tunnel.
  if (matchesIpv6Cidr(words, { bits: 96, words: [0x64, 0xff9b, 0, 0, 0, 0, 0, 0] })) {
    return isBlockedIPv4(embeddedV4(6));
  }
  if (IPV6_IANA_GLOBAL_EXCEPTIONS.some((cidr) => matchesIpv6Cidr(words, cidr))) return false;
  if (IPV6_NON_GLOBAL_CIDRS.some((cidr) => matchesIpv6Cidr(words, cidr))) return true;
  // A syntactically global-unicast address is not necessarily allocated or
  // globally reachable. The allocation allowlist makes future IANA space fail
  // closed until this audited snapshot is updated.
  return !IPV6_ALLOCATED_GLOBAL_CIDRS.some((cidr) => matchesIpv6Cidr(words, cidr));
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

async function resolvePublicAddresses(url: URL, resolve: NonNullable<SafeFetchDependencies["resolve"]>) {
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
  // Retain the whole validated answer set. A later transport failure may use
  // another answer, but every candidate was checked as one atomic DNS result.
  return answers.map((answer) => ({ address: answer.address, family: isIP(answer.address) }));
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

async function within<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new SafeFetchError("SAFE_FETCH_ABORTED");
    const operations = [
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SafeFetchError("SAFE_FETCH_TIMEOUT")), timeoutMs);
      }),
    ];
    if (signal) {
      operations.push(new Promise<T>((_resolve, reject) => {
        abort = () => reject(new SafeFetchError("SAFE_FETCH_ABORTED"));
        signal.addEventListener("abort", abort, { once: true });
      }));
    }
    return await Promise.race(operations);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

const defaultResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

function responseDecoder(contentEncoding: string | string[] | undefined): Transform | undefined {
  if (Array.isArray(contentEncoding)) throw new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
  const encoding = contentEncoding?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return undefined;
  // A stacked encoding needs a verified reverse decoder chain. Fail closed
  // until that chain is deliberately implemented rather than misrepresenting
  // encoded bytes as decoded Fetch-compatible content.
  if (encoding.includes(",")) throw new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
  if (encoding === "gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
}

function responseHeadersWithoutEncoding(headers: http.IncomingHttpHeaders) {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized.set(name, value);
    else if (Array.isArray(value)) normalized.set(name, value.join(", "));
  }
  normalized.delete("content-encoding");
  normalized.delete("content-length");
  return normalized;
}

export function pinnedSafeFetchRequestOptions(
  url: URL,
  input: Pick<Parameters<Transport>[1], "headers" | "address">,
): http.RequestOptions & Pick<HttpsRequestOptions, "servername" | "rejectUnauthorized"> {
  const tlsIdentity = bareHost(url.hostname);
  const options: http.RequestOptions & Pick<HttpsRequestOptions, "servername" | "rejectUnauthorized"> = {
    protocol: url.protocol,
    hostname: input.address.address,
    family: input.address.family,
    // Never inherit Node's mutable global agents. Node 24 can replace them
    // with EnvHttpProxyAgent when NODE_USE_ENV_PROXY=1, which would route the
    // request to a proxy instead of the DNS-vetted, pinned address above.
    agent: false,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      ...Object.fromEntries(new Headers(input.headers).entries()),
      host: url.host,
      // Ask upstream for a directly usable representation. We still decode
      // recognized encodings below because intermediaries may ignore this.
      "accept-encoding": "identity",
    },
  };
  // Node requires an unbracketed TLS identity. IP literals are certificate
  // identities, not virtual-host names, and must never emit an SNI extension.
  if (url.protocol === "https:") {
    // Fix certificate validation at the request boundary. Otherwise the
    // process-wide NODE_TLS_REJECT_UNAUTHORIZED=0 escape hatch overrides the
    // security invariant this transport is responsible for enforcing.
    options.rejectUnauthorized = true;
    if (!isIP(tlsIdentity)) options.servername = tlsIdentity;
  }
  return options;
}

export const pinnedSafeFetchTransport: Transport = (url, input) => new Promise((resolve, reject) => {
  let settled = false;
  let request: http.ClientRequest | undefined;
  let upstreamResponse: http.IncomingMessage | undefined;
  let decoder: Transform | undefined;
  const control: { deadlineTimer?: ReturnType<typeof setTimeout> } = {};
  const abortRequest = () => fail(new SafeFetchError("SAFE_FETCH_ABORTED"), true);
  const cleanup = () => {
    if (control.deadlineTimer) clearTimeout(control.deadlineTimer);
    input.signal?.removeEventListener("abort", abortRequest);
  };
  const succeed = (response: Response) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(response);
  };
  const asTransportFailure = (error: unknown) => error instanceof SafeFetchError
    ? error
    : new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
  const fail = (error: unknown, closePeer = false) => {
    const safeError = asTransportFailure(error);
    if (settled) return;
    // Settle before destroying resources. destroy(error) may synchronously or
    // asynchronously emit "error"; the permanently attached request listener
    // then observes an already-settled operation instead of becoming an
    // unhandled late process exception.
    settled = true;
    cleanup();
    if (closePeer) {
      decoder?.destroy(safeError);
      upstreamResponse?.destroy(safeError);
      request?.destroy(safeError);
    }
    reject(safeError);
  };

  if (input.signal?.aborted) {
    abortRequest();
    return;
  }

  const client = url.protocol === "https:" ? https : http;
  // Dial the validated IP directly instead of asking Node's HTTP agent to look
  // it up again. Retain the original Host/SNI identity so virtual hosts and
  // HTTPS certificate validation behave like the validated URL.
  // Do not rewrite URL.hostname here. In particular, assigning a raw IPv6
  // literal to URL.hostname produces a malformed authority on supported Node
  // versions. Explicit request options also make the no-second-lookup
  // guarantee inspectable: the socket destination is the checked address,
  // while Host and SNI retain the original URL identity.
  const handleResponse = (upstream: http.IncomingMessage) => {
    if (settled) {
      upstream.destroy();
      return;
    }
    upstreamResponse = upstream;
    try {
      upstream.on("error", (error) => fail(error));
      const contentLength = Number(upstream.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > input.maxBodyBytes) {
        fail(new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE"), true);
        return;
      }
      if (input.discardBody) {
        const status = upstream.statusCode ?? 502;
        try {
          // Metadata callers must never accumulate or drain an arbitrary body.
          // Resolve first, then close the peer; the permanent error listeners
          // above keep a late close/error from escaping as an unhandled event.
          succeed(responseWithUrl(new Response(null, {
            status,
            statusText: upstream.statusMessage,
            headers: responseHeadersWithoutEncoding(upstream.headers),
          }), url));
          upstream.destroy();
        } catch (error) {
          fail(error, true);
        }
        return;
      }
      const chunks: Buffer[] = [];
      let wireBytes = 0;
      let decodedBytes = 0;
      const status = upstream.statusCode ?? 502;
      const finish = () => {
        // The Fetch standard forbids bodies for these statuses. More
        // importantly, constructing a Response with a Buffer for one throws.
        const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
        try {
          const response = responseWithUrl(new Response(body, {
            status,
            statusText: upstream.statusMessage,
            headers: responseHeadersWithoutEncoding(upstream.headers),
          }), url);
          succeed(response);
        } catch (error) {
          fail(error, true);
        }
      };
      const onWireData = (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > input.maxBodyBytes) {
          fail(new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE"), true);
          return;
        }
      };
      const onDecodedData = (chunk: Buffer) => {
        decodedBytes += chunk.length;
        if (decodedBytes > input.maxBodyBytes) {
          fail(new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE"), true);
          return;
        }
        chunks.push(chunk);
      };
      upstream.on("data", onWireData);
      decoder = responseDecoder(upstream.headers["content-encoding"]);
      if (decoder) {
        decoder.on("data", onDecodedData);
        decoder.on("error", (error: Error) => fail(error, true));
        decoder.on("end", finish);
        upstream.pipe(decoder);
      } else {
        upstream.on("data", onDecodedData);
        upstream.on("end", finish);
      }
    } catch (error) {
      fail(error, true);
    }
  };

  try {
    // Header normalization is deliberately inside the setup boundary: invalid
    // caller-provided HeadersInit must reject with the safe transport code,
    // never escape the Promise executor as a raw TypeError.
    request = client.request(pinnedSafeFetchRequestOptions(url, input), handleResponse);
    // Install this before every other fallible ClientRequest operation.
    // In particular, setTimeout(-1) throws after request construction while a
    // connection error may still arrive on a later turn.
    request.on("error", (error) => fail(error));
    request.setTimeout(input.timeoutMs, () => fail(new SafeFetchError("SAFE_FETCH_TIMEOUT"), true));
    // `request.setTimeout` is an inactivity timeout; retain a total deadline so
    // a peer dribbling bytes cannot keep a request alive indefinitely.
    control.deadlineTimer = setTimeout(
      () => fail(new SafeFetchError("SAFE_FETCH_TIMEOUT"), true),
      input.timeoutMs,
    );
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    if (input.signal?.aborted) {
      abortRequest();
      return;
    }
    request.end();
  } catch (error) {
    fail(error, true);
  }
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
  const discardBody = options.responseBodyMode === "discard";
  if ((options.responseBodyMode !== undefined && options.responseBodyMode !== "buffer" && options.responseBodyMode !== "discard")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new SafeFetchError("SAFE_FETCH_INVALID_URL");

  let url = parseUrl(raw, options.allowedHosts);
  if (options.signal?.aborted) throw new SafeFetchError("SAFE_FETCH_ABORTED");
  let headers: HeadersInit | undefined;
  try {
    headers = sanitizedHeaders(options.headers);
  } catch {
    throw new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
  }
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("SAFE_FETCH_TIMEOUT");
    const addresses = await within(resolvePublicAddresses(url, resolve), remaining, options.signal);
    let response: Response | undefined;
    let lastTransportFailure: SafeFetchError | undefined;
    for (const address of addresses) {
      if (options.signal?.aborted) throw new SafeFetchError("SAFE_FETCH_ABORTED");
      const attemptRemaining = deadline - Date.now();
      if (attemptRemaining <= 0) throw new SafeFetchError("SAFE_FETCH_TIMEOUT");
      try {
        response = await within(
          transport(url, { headers, timeoutMs: attemptRemaining, maxBodyBytes, address, signal: options.signal, discardBody }),
          attemptRemaining,
          options.signal,
        );
        break;
      } catch (error) {
        const safeError = error instanceof SafeFetchError
          ? error
          : new SafeFetchError(options.signal?.aborted ? "SAFE_FETCH_ABORTED" : "SAFE_FETCH_TRANSPORT_FAILED");
        // A fully validated alternative address is a transport resilience
        // option only. Policy outcomes are terminal and never retried.
        if (safeError.code !== "SAFE_FETCH_TRANSPORT_FAILED") throw safeError;
        lastTransportFailure = safeError;
      }
    }
    if (!response) throw lastTransportFailure ?? new SafeFetchError("SAFE_FETCH_TRANSPORT_FAILED");
    responseWithUrl(response, url);
    const advertisedLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBodyBytes) {
      throw new SafeFetchError("SAFE_FETCH_BODY_TOO_LARGE");
    }
    // Fetch only follows the defined redirect statuses. In particular, 304 is
    // a terminal cache-validation response even when a hostile Location header
    // is present; treating every 3xx as a redirect would issue an extra hop.
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
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
