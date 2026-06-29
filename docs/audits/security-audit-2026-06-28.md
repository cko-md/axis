# Security Audit Report — AXIS Platform

**Date:** 2026-06-28  
**Scope:** Full codebase security audit  
**Status:** Findings documented; Linear tickets to be created  

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 11 |
| Medium | 15 |
| Low | 8 |
| **Total** | **36** |

**Positive findings:** All database queries use Supabase's parameterized SDK (no SQL injection). RLS is enabled on all tables with proper `auth.uid() = user_id` policies. The previously vulnerable `search_note_embeddings` RPC has been fixed. Webhooks use proper HMAC-SHA256/JWT verification. AES-256-GCM encryption protects stored OAuth tokens. DOMPurify sanitizes email HTML and reader-mode content. Sentry is configured for observability. Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) are set.

---

## Critical Findings

### CRIT-01: Proxy serves unsanitized HTML with allow-scripts + allow-same-origin sandbox (XSS → Account Takeover)

- **Category:** Cross-Site Scripting
- **Files:**
  - `src/app/api/proxy/route.ts:107-128`
  - `src/components/ui/WebViewer.tsx:459`
  - `next.config.ts:155-164`
- **Code:**

```typescript
// proxy/route.ts — fetches and serves arbitrary HTML without sanitization
let html = await upstream.text();
// ... injects base tag and navigation interceptor ...
return new NextResponse(html, {
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
```

```html
<!-- WebViewer.tsx — sandbox allows scripts + same-origin -->
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
```

```
// next.config.ts — permissive CSP for proxy route
default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; ...
```

- **Impact:** The `/api/proxy` route fetches arbitrary HTML from user-supplied URLs, does NOT sanitize it with DOMPurify, and returns it as `text/html`. This HTML is rendered in a same-origin iframe with `allow-scripts allow-same-origin`. The combination of `allow-scripts` + `allow-same-origin` negates the iframe sandbox — any scripts in proxied pages execute with the same origin as the Axis app. A malicious page loaded through the proxy can: (1) make authenticated API requests to `/api/*` using the user's session cookies, (2) access the parent window DOM, (3) read non-httpOnly cookies, (4) exfiltrate the Spotify access token, and (5) exfiltrate the passkey refresh token (CRIT-02).
- **Recommended fix:**
  1. Remove `allow-same-origin` from the iframe sandbox attribute. This prevents proxied scripts from accessing the parent's cookies/DOM/API.
  2. Sanitize proxied HTML with DOMPurify server-side before returning it (as is done for reader-mode content and email bodies).
  3. If `allow-same-origin` is required for functionality, use a separate subdomain for the proxy iframe so that same-origin policy isolates it from the main app.

---

### CRIT-02: WebAuthn authentication challenge not bound to user or credential (Cross-User Challenge Replay)

- **Category:** Authentication Bypass
- **File:** `src/app/api/auth/passkey/authenticate/route.ts:130-143`
- **Code:**

```typescript
const { data: challenges } = await supabase
  .from("webauthn_challenges")
  .select("id, challenge")
  .eq("type", "authentication")
  .gt("expires_at", now)
  .order("created_at", { ascending: false })
  .limit(1);

const challengeRow = challenges?.[0];
```

- **Impact:** The authentication challenge is fetched without filtering by `user_id` or `credential_id`. It simply grabs the most recent unexpired authentication challenge for ANY user. This creates two attack vectors: (1) **Challenge replay across users** — User A requests authentication options (creating a challenge), then User B can use User A's challenge to authenticate with User B's credentials. (2) **Race condition** — If two users request authentication simultaneously, one user's verification could consume the other's challenge. The registration route correctly binds the challenge to `user_id`, but the authentication route does not.
- **Recommended fix:** Bind the authentication challenge to a specific credential or user. When creating authentication options, store the challenge with the target credential's ID. When verifying, fetch the challenge filtered by that credential ID and delete it after use.

---

## High Findings

### HIGH-01: SSRF guard vulnerable to DNS rebinding, IPv6 bypass, and redirect-follow

- **Category:** Server-Side Request Forgery
- **Files:**
  - `src/lib/security/ssrf.ts:26-41`
  - `src/app/api/proxy/route.ts:61-78`
- **Code:**

```typescript
// ssrf.ts — only checks hostname, not resolved IP
const h = u.hostname.toLowerCase();
if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
if (/^10\./.test(h)) return true;
if (/^192\.168\./.test(h)) return true;
if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
```

```typescript
// proxy/route.ts — follows redirects after SSRF check passes
const upstream = await fetch(url, { redirect: 'follow' });
```

- **Impact:** The SSRF guard blocks private IP ranges at the URL-parsing level but does NOT protect against: (1) DNS rebinding — a domain resolving to `127.0.0.1` passes the check since the hostname is not a private IP; (2) IPv6-mapped IPv4 — `::ffff:127.0.0.1` bypasses regex checks; (3) Redirect chains — an initial safe URL redirects to an internal IP after the check passes.
- **Recommended fix:**
  1. Resolve DNS before fetching and verify the resolved IP is not in a private range.
  2. Disable automatic redirect following (`redirect: 'manual'`) and validate each redirect URL through `isBlockedUrl()`.
  3. Add IPv6-mapped IPv4 patterns to the blocklist (`::ffff:*`).

---

### HIGH-02: Passkey refresh token returned in authentication response body

- **Category:** Sensitive Data Exposure
- **File:** `src/app/api/auth/passkey/authenticate/route.ts:174-185`
- **Code:**

```typescript
return NextResponse.json({
  verified: true,
  userId: resolvedUserId,
  ...(refreshToken ? { refreshToken } : {}),
});
```

- **Impact:** The Supabase refresh token is returned in the JSON response body of the passkey authenticate endpoint. This is a pre-auth endpoint. If the response is intercepted (via XSS, compromised browser extension, or network sniffing), the attacker obtains a refresh token granting full account access indefinitely.
- **Recommended fix:** Set the refresh token as an httpOnly cookie instead of returning it in the JSON body. Do not expose `userId` in the response either.

---

### HIGH-03: WebAuthn RP origin falls back to unvalidated environment variable

- **Category:** Authentication Bypass
- **File:** `src/lib/webauthn/server.ts:17-24`
- **Code:**

```typescript
export function getRpConfig(): { rpID: string; origin: string } {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3200";
  try {
    const url = new URL(raw);
    return { rpID: url.hostname, origin: url.origin };
  } catch {
    return { rpID: "localhost", origin: raw };
  }
}
```

- **Impact:** If `NEXT_PUBLIC_APP_URL` is unset or malformed, the fallback returns `{ rpID: "localhost", origin: raw }` where `raw` is the unvalidated string. The catch block doesn't parse the URL — it passes the raw string as the `origin` for WebAuthn verification. Production could silently accept `localhost` as the RP ID, allowing passkeys registered on localhost to authenticate against the production domain.
- **Recommended fix:** Throw an error if the URL cannot be parsed. Never fall back to `localhost` in production. Validate `NEXT_PUBLIC_APP_URL` at startup.

---

### HIGH-04: Composio connect redirects to externally-sourced URL without validation

- **Category:** Open Redirect
- **File:** `src/app/api/integrations/composio/connect/route.ts:81`
- **Code:**

```typescript
return NextResponse.redirect(redirectUrl);
```

- **Impact:** The `redirectUrl` comes from the Composio API's `initiateConnection()` response. If the Composio API is compromised, or a malicious toolkit name causes it to return an attacker-controlled URL, the user's browser will be redirected to an arbitrary external site while carrying their Axis session cookies.
- **Recommended fix:** Validate `redirectUrl` against an allowlist of known OAuth provider domains (e.g., `accounts.google.com`, `login.microsoftonline.com`, etc.).

---

### HIGH-05: No rate limiting on email send, transcription, Composio execute, brokerage order

- **Category:** Rate Limiting
- **Files:**
  - `src/app/api/mail/send/route.ts` — no rate limiting
  - `src/app/api/notes/transcribe/route.ts` — no rate limiting
  - `src/app/api/integrations/composio/execute/route.ts` — no rate limiting
  - `src/app/api/brokerage/order/route.ts` — no rate limiting
- **Impact:**
  - **Email send:** Unlimited emails through connected accounts → Gmail account suspension, spam abuse.
  - **Transcription:** Unlimited Gemini API calls → quota exhaustion, cost abuse.
  - **Composio execute:** Generic tool-execution bridge without limits → mass email deletion, calendar spam.
  - **Brokerage order:** When live routing is enabled → unlimited trade orders.
- **Recommended fix:** Add Redis-backed rate limiting (with in-memory fallback) to all state-changing and cost-incurring routes. Follow the pattern used by `/api/ai` and `/api/signals-ai`.

---

### HIGH-06: Library file upload has no server-side validation

- **Category:** Insecure File Upload
- **File:** `src/lib/hooks/useLibraryFiles.ts:49-85`
- **Code:**

```typescript
const storagePath = `${user.id}/${crypto.randomUUID()}-${file.name}`;
const { error: uploadError } = await supabase.storage
  .from(BUCKET)
  .upload(storagePath, file, { contentType: file.type || undefined });
```

- **Impact:** File uploads are done entirely client-side. No server-side MIME type validation (file.type can be spoofed), no file size limit, no file extension validation. Any file type can be uploaded including `.html`, `.svg`, `.exe`. The file name is used unsanitized in the storage path.
- **Recommended fix:** Create a server-side API route that validates file type (by magic bytes, not Content-Type), file size, and file extension before allowing the upload.

---

### HIGH-07: next-pwa v5.6.0 — unmaintained package with known issues

- **Category:** Insecure Dependencies
- **File:** `package.json:38`
- **Code:** `"next-pwa": "^5.6.0"`
- **Impact:** `next-pwa` v5.6.0 is unmaintained (last release 2021), has known incompatibilities with Next.js 13+, and forces the webpack `hashFunction = "sha256"` workaround. Its Workbox runtime files (`sw.js`, `workbox-*.js`) in `public/` are stale, unreviewable code served to every client.
- **Recommended fix:** Migrate to `@ducanh2912/next-pwa` or remove PWA support.

---

### HIGH-08: In-memory rate limiter ineffective on serverless

- **Category:** Rate Limiting
- **File:** `src/lib/ratelimit.ts:1-18`
- **Code:**

```typescript
const store = new Map<string, { count: number; resetAt: number }>();
```

- **Impact:** The in-memory rate limiter uses a module-level `Map` that is created fresh on each serverless function invocation. In Vercel's serverless model, each request may hit a different function instance, making the in-memory limiter bypassable. Routes that use only the memory limiter (like `/api/fund/advisor`) have no effective rate limiting.
- **Recommended fix:** Ensure all rate-limited routes use the Redis-backed limiter with in-memory fallback only as a degradation path. The `/api/fund/advisor` route uses only the memory limiter.

---

### HIGH-09: Middleware incomplete auth guard — allow-by-default model for API routes

- **Category:** Authentication / Authorization
- **File:** `src/middleware.ts:61-87`
- **Code:**

```typescript
if (pathname.startsWith("/api")) {
  if (!user && GUARDED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  return supabaseResponse; // ALL other /api/* routes pass through
}
```

- **Impact:** The middleware uses an allow-list approach for API auth guarding. 18+ authenticated API routes are NOT in `GUARDED_PREFIXES` and rely solely on per-route auth checks. If a route handler's auth check is accidentally removed or has a bug, there is no middleware-level safety net. Critical routes like `/api/proxy` (SSRF/XSS vector), `/api/contacts` (PII), and `/api/embeddings` are unguarded at the middleware level.
- **Recommended fix:** Invert the logic to deny-by-default: block all `/api/*` routes for unauthenticated users unless they are in `PUBLIC_API_PREFIXES`.

---

### HIGH-10: Empty catch block in SSRF proxy route

- **Category:** Improper Error Handling
- **File:** `src/app/api/proxy/route.ts:21`
- **Code:** `}catch(err){}`
- **Impact:** The proxy route — the most security-sensitive route — has an empty catch block in the navigation-interceptor script injection. Errors in the click interception logic are silently swallowed, potentially allowing navigation to escape the iframe sandbox without the parent being notified.
- **Recommended fix:** Log the error and send it to Sentry. Per AGENTS.md §2: "Swallowed catch blocks are not acceptable."

---

### HIGH-11: Spotify access token returned to client (compounds with XSS)

- **Category:** Sensitive Data Exposure
- **File:** `src/app/api/spotify/token/route.ts:16`
- **Code:** `return NextResponse.json({ access_token: token });`
- **Impact:** The Spotify access token is returned in a JSON API response body, making it available to any JavaScript running on the page. Combined with CRIT-01 (proxy XSS), a malicious proxied page can fetch `/api/spotify/token` and exfiltrate the token.
- **Recommended fix:** This is required by the Spotify Web Playback SDK. Mitigate by fixing CRIT-01 first (removing `allow-same-origin` from the iframe sandbox). Consider adding a short-lived one-time-use token exchange mechanism.

---

## Medium Findings

### MED-01: postMessage uses wildcard origin `'*'`

- **Category:** Cross-Site Scripting
- **File:** `src/app/api/proxy/route.ts:19,39`
- **Code:** `window.parent.postMessage({type:'proxy-navigate',url:abs},'*');`
- **Recommended fix:** Replace `'*'` with the specific app origin (e.g., `window.location.origin` of the parent).

### MED-02: CSP 'unsafe-eval' weakens XSS protection

- **Category:** Content Security Policy
- **File:** `next.config.ts:57`
- **Code:** `"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com"`
- **Recommended fix:** Remove `'unsafe-eval'` if possible. Next.js App Router requires `unsafe-inline` for hydration but `unsafe-eval` is typically avoidable.

### MED-03: Gemini API key passed as URL query parameter

- **Category:** Secrets Leakage
- **Files:** `src/lib/ai/embed.ts:14`, `src/app/api/notes/transcribe/route.ts:68`
- **Code:** `` `https://generativelanguage.googleapis.com/...?key=${apiKey}` ``
- **Recommended fix:** Use the `x-goog-api-key` HTTP header instead of the query parameter to avoid the key appearing in server logs, Sentry captures, or Vercel request logs.

### MED-04: Upstream API error details leaked to client

- **Category:** Information Disclosure
- **File:** `src/app/api/notes/transcribe/route.ts:90`
- **Code:** `{ error: \`Transcription failed (${res.status}).\`, detail: detail.slice(0, 200) }`
- **Recommended fix:** Do not return upstream error details to the client. Log them server-side and return a generic error message.

### MED-05: Supabase/Plaid error messages returned verbatim to client

- **Category:** Information Disclosure
- **Files:** `src/app/api/fund/holdings/route.ts:33`, `src/app/api/auth/passkey/token/route.ts:42`, `src/app/api/auth/passkey/list/route.ts:20`, `src/app/api/plaid/exchange/route.ts:46-49`, `src/app/api/auth/mfa/verify/route.ts:66`, `src/app/api/auth/mfa/unenroll/route.ts:33`
- **Code:** `return NextResponse.json({ error: error.message }, { status: 500 });`
- **Recommended fix:** Sanitize error messages before returning to the client. Log the full error server-side (with Sentry capture) and return a generic message.

### MED-06: WebAuthn verification errors returned to client

- **Category:** Information Disclosure
- **Files:** `src/app/api/auth/passkey/authenticate/route.ts:157`, `src/app/api/auth/passkey/register/route.ts:111`
- **Code:** `const message = err instanceof Error ? err.message : "Verification failed";`
- **Recommended fix:** Return a generic "Verification failed" message. Log the specific error server-side with Sentry.

### MED-07: Missing note ownership verification before upsert in /api/embeddings

- **Category:** Authorization
- **File:** `src/app/api/embeddings/route.ts:17-43`
- **Code:** The route accepts a `noteId` from the request body and writes an embedding for it without verifying that the note belongs to the authenticated user. While RLS prevents inserting rows with a different `user_id`, the `onConflict: "note_id"` upsert could attempt to update a row owned by another user.
- **Recommended fix:** Verify that the note belongs to the authenticated user before upserting the embedding.

### MED-08: State-changing operations via GET (Strava disconnect, Composio connect)

- **Category:** CSRF
- **Files:** `src/app/api/strava/route.ts:121-126`, `src/app/api/integrations/composio/connect/route.ts:26`
- **Code:** GET requests that perform disconnect/connect actions. GET requests are vulnerable to CSRF — a malicious page can trigger `fetch('/api/strava?action=disconnect')`.
- **Recommended fix:** Change these to POST/DELETE methods. Use CSRF tokens or validate the Origin header.

### MED-09: No Origin/Referer validation on state-changing POST routes

- **Category:** CSRF
- **Files:** All 61 POST/PUT/DELETE/PATCH route handlers
- **Impact:** While Supabase session cookies are `SameSite=Lax` (which protects against cross-site POST from top-level navigations), `SameSite=Lax` does NOT protect against sub-requests in cross-origin iframes or older browsers.
- **Recommended fix:** Validate the `Origin` or `Referer` header on all state-changing routes. Add a CSRF token mechanism for the most critical routes (email send, account changes, brokerage orders).

### MED-10: Gallery route silently swallows all errors (8 paths)

- **Category:** Improper Error Handling
- **File:** `src/app/api/gallery/route.ts:161-359`
- **Code:** `} catch { return NextResponse.json({ works: [], query }); }`
- **Recommended fix:** Capture errors with Sentry and include an `error` field in the response so the UI can show a visible error state.

### MED-11: Silent error return in /api/briefing/fetch-feeds

- **Category:** Improper Error Handling
- **File:** `src/app/api/briefing/fetch-feeds/route.ts:14-16`
- **Code:** `} catch { return NextResponse.json({ items: [] }); }`
- **Recommended fix:** Capture with Sentry, return error field.

### MED-12: Crypto decrypt silently returns null on failure

- **Category:** Improper Error Handling
- **File:** `src/lib/crypto.ts:35-36`
- **Code:** `} catch { return null; }`
- **Recommended fix:** Log a warning when decryption fails. Surface the issue to the user (e.g., "Passkey session data is corrupted — please re-register").

### MED-13: Avatar upload trusts client-reported MIME type

- **Category:** Insecure File Upload
- **File:** `src/app/api/profile/avatar/route.ts:23-28`
- **Code:** `const ext = ALLOWED_MIME_TO_EXT[file.type];`
- **Recommended fix:** Validate the file's actual magic bytes, not just the declared Content-Type header.

### MED-14: Permissive CSP on /api/proxy route

- **Category:** Content Security Policy
- **File:** `next.config.ts:155-164`
- **Impact:** The permissive CSP means security depends entirely on the iframe `sandbox` attribute, which is set client-side and could be modified by a browser extension or XSS.
- **Recommended fix:** This is intentional for the proxy design, but combined with CRIT-01, the defense-in-depth is broken. Fix CRIT-01 first.

### MED-15: XSS risk in proxy reader fallback HTML construction

- **Category:** Cross-Site Scripting
- **File:** `src/app/api/proxy/route.ts:32-39`
- **Code:** String interpolation for HTML with limited escaping (only `"` and `<`).
- **Recommended fix:** Use a proper HTML/JS escaping library instead of manual string replacement.

---

## Low Findings

### LOW-01: API key configuration state exposed to unauthenticated users

- **Files:** `src/app/api/ai/status/route.ts:10-19`, `src/app/api/massive/status/route.ts:4-12`
- **Impact:** Reveals whether Anthropic/Polygon API keys are configured. Aids reconnaissance.
- **Recommended fix:** Require authentication for these endpoints.

### LOW-02: Public API routes can be abused as open proxies

- **Files:** `src/app/api/widgets/art/route.ts`, `src/app/api/literature/route.ts`
- **Impact:** Unauthenticated users can call these endpoints to fetch from external APIs, potentially exhausting rate limits or bypassing IP restrictions.
- **Recommended fix:** Require authentication or add IP-based rate limiting.

### LOW-03: localStorage usage exfiltrable via XSS

- **Files:** Various components (~60+ instances)
- **Impact:** localStorage is accessible to any JavaScript on the page. Combined with CRIT-01, stored data could be exfiltrated. Mostly UI preferences and non-critical data.
- **Recommended fix:** Fix CRIT-01 first. Move sensitive data to Supabase instead of localStorage.

### LOW-04: Wildcard image remote patterns

- **File:** `next.config.ts:128`
- **Code:** `{ protocol: "https", hostname: "**" }`
- **Impact:** Next.js image proxy can fetch from any HTTPS hostname (mild SSRF vector through image optimization).
- **Recommended fix:** Restrict to known image hostnames.

### LOW-05: Timing-unsafe comparison for CRON_SECRET

- **File:** `src/app/api/cron/daily/route.ts:13`
- **Code:** `` if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) ``
- **Impact:** Vulnerable to timing attacks. The Make webhook route correctly uses `timingSafeEqual`.
- **Recommended fix:** Use `crypto.timingSafeEqual()` for all secret comparisons.

### LOW-06: OAuth tokens in non-secure cookies in development

- **Files:** `src/app/api/spotify/callback/route.ts:38-53`, `src/app/api/strava/route.ts:101-113`
- **Code:** `secure: process.env.NODE_ENV === "production"`
- **Impact:** In non-production environments, OAuth tokens are stored in cookies without the `secure` flag.
- **Recommended fix:** Enforce `secure: true` in all non-local deployments.

### LOW-07: Strava callback cookies missing `secure` flag (inconsistent with refresh handler)

- **File:** `src/app/api/strava/route.ts:101-113`
- **Impact:** The callback handler does not include the `secure` flag at all (unlike the Spotify callback and the Strava refresh handler in `_lib.ts` which do).
- **Recommended fix:** Add `secure: process.env.NODE_ENV === "production"` to both cookie sets in the callback handler.

### LOW-08: Middleware redirect parameter unsanitized

- **File:** `src/middleware.ts:93`
- **Code:** `url.searchParams.set("redirect", pathname);`
- **Impact:** The middleware sets the redirect search param to the raw pathname without validation. Mitigated downstream by the login page's validation.
- **Recommended fix:** Add explicit validation at the middleware level for defense-in-depth.

---

## Linear Ticket Plan

The following tickets should be created in Linear:

| Ticket | Title | Priority | Labels |
|--------|-------|----------|--------|
| 1 | CRIT: Proxy XSS via unsanitized HTML + allow-same-origin sandbox | Urgent | security, vulnerability, xss |
| 2 | CRIT: WebAuthn auth challenge not bound to user — cross-user replay | Urgent | security, vulnerability, auth-bypass |
| 3 | HIGH: SSRF guard bypass via DNS rebinding/IPv6/redirect-follow | Urgent | security, vulnerability, ssrf |
| 4 | HIGH: Passkey refresh token exposed in API response body | Urgent | security, vulnerability, data-exposure |
| 5 | HIGH: WebAuthn RP origin fallback to unvalidated env var | Urgent | security, vulnerability, auth-bypass |
| 6 | HIGH: Composio connect open redirect without URL validation | Urgent | security, vulnerability, open-redirect |
| 7 | HIGH: Missing rate limiting on email send, transcription, Composio execute, brokerage order | Urgent | security, vulnerability, rate-limiting |
| 8 | HIGH: Library file upload has no server-side validation | Urgent | security, vulnerability, file-upload |
| 9 | HIGH: next-pwa v5.6.0 unmaintained — migrate or remove | Urgent | security, vulnerability, dependencies |
| 10 | HIGH: In-memory rate limiter ineffective on serverless | Urgent | security, vulnerability, rate-limiting |
| 11 | HIGH: Middleware allow-by-default API auth model | Urgent | security, vulnerability, auth |
| 12 | HIGH: Empty catch block in SSRF proxy route | Urgent | security, vulnerability, error-handling |
| 13 | HIGH: Spotify token exposed to client (compounds with XSS) | Urgent | security, vulnerability, data-exposure |
| 14 | MED: postMessage wildcard origin in proxy | High | security, vulnerability, xss |
| 15 | MED: CSP unsafe-eval weakens XSS protection | High | security, vulnerability, csp |
| 16 | MED: Gemini API key in URL query parameter | High | security, vulnerability, secrets |
| 17 | MED: Upstream error details leaked to client | High | security, vulnerability, info-disclosure |
| 18 | MED: Supabase/Plaid error messages returned verbatim | High | security, vulnerability, info-disclosure |
| 19 | MED: WebAuthn verification errors returned to client | High | security, vulnerability, info-disclosure |
| 20 | MED: Missing note ownership verification in /api/embeddings | High | security, vulnerability, authorization |
| 21 | MED: State-changing operations via GET (CSRF risk) | High | security, vulnerability, csrf |
| 22 | MED: No Origin/Referer validation on POST routes | High | security, vulnerability, csrf |
| 23 | MED: Gallery route silently swallows all errors | High | security, vulnerability, error-handling |
| 24 | MED: Silent error returns in fetch-feeds and crypto decrypt | High | security, vulnerability, error-handling |
| 25 | MED: Avatar upload trusts client MIME type | High | security, vulnerability, file-upload |
| 26 | MED: XSS risk in proxy reader fallback HTML construction | High | security, vulnerability, xss |
