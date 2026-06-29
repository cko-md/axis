# Sentry Verification

AXIS uses `@sentry/nextjs` for client, server, and edge error capture. The
Sentry project is `kevin-ogonuwe/javascript-nextjs` in the US region.

## Runtime behavior

- Local development is quiet unless `NEXT_PUBLIC_SENTRY_DSN` is explicitly set.
- Preview and production use `NEXT_PUBLIC_SENTRY_DSN` when configured in Vercel.
- Source maps upload during Vercel builds when `SENTRY_AUTH_TOKEN` is present.
- Browser replay masks all text and blocks all media.
- Sentry traffic is tunneled through `/monitoring`.

## Scrubbing

All client, server, and edge events run through `scrubSentryEvent` before send.
Browser replay also masks all text and blocks all media. The scrubber removes
or redacts:

- cookies and auth headers
- token, secret, password, and API-key fields
- request bodies and mail body/html/text fields
- email addresses in strings
- user email and IP fields

Do not attach OAuth payloads, access tokens, raw email bodies, or private user
content to Sentry events. Provider failures should use safe tags such as
`area`, `op`, `provider`, `transport`, `code`, and HTTP status.

## Backlog review on 2026-06-29

Reviewed unresolved Sentry issues after the KEV-10 production deploy:

- `JAVASCRIPT-NEXTJS-2`: `/briefing` hydration error, last seen 2026-06-27 on
  release `04c92f463600758dd7ae6e63eca6a9f796d81160`; no production events in
  the latest 24h. Resolved as stale; reopen/split if it regresses.
- `JAVASCRIPT-NEXTJS-3`: one development-only localhost `ENOENT stat` event
  from `http://localhost:3200/`. Resolved as non-production noise.
- `JAVASCRIPT-NEXTJS-1`: Sentry sample/example Next.js exception with
  `sample_event=yes`. Resolved as sample noise.

Latest release checked: `7685e1a01573a819664aaf5f1e0f2248c11134d3`.
No production error events were found for that release.

## Post-deploy check

Use Sentry MCP after each production deploy:

1. Find org/project: `kevin-ogonuwe` / `javascript-nextjs`.
2. Search project issues: `is:unresolved environment:production` over `24h`.
3. Search errors for the release SHA: `environment:production release:<sha>`.
4. Search route-specific errors when validating a feature, for example
   `environment:production transaction:"/api/mail/message/[id]/action"`.
5. Check Vercel runtime logs for `error` and `fatal` over the deploy window.

Happy paths should not create new Sentry issues. Expected provider 4xx failures
should return visible UI feedback and structured responses without noisy Sentry
captures.
