# ADR 0004 — Canonical entity identity and URL-restorable workspace

- Status: accepted
- Date: 2026-07-16
- Wave: Phase 7.2–7.4

## Context

AXIS already had module-specific records, route navigation, a command palette,
and a search surface, but no shared identity contract for opening the same item
from search, previews, backlinks, commands, or a split workspace. The modules
must remain their own sources of truth: copying private content into a universal
entity table would create stale duplicates and a larger privacy boundary.

The workspace also needs browser-native restore, reload, and back/forward
behavior without persisting private pane contents or search queries. Any durable
relationship or ranking signal must be owner-scoped and must not let a client
assert ownership by supplying a `user_id`.

## Options considered

1. **Copy every module record into one universal entity table.** This would make
   lookup uniform, but duplicates content, creates synchronization races, and
   broadens the schema and RLS surface for notes, people, tasks, financial
   records, and provider-backed data.
2. **Keep untyped route links and store pane state in `localStorage`.** This is
   easy to add, but cannot provide canonical backlinks, cross-route continuity,
   shareable/reloadable workspaces, or browser history semantics. It also
   perpetuates the existing ambiguity between durable agent Tasks and Agenda
   to-dos.
3. **Persist complete workspaces and search history in Postgres.** This supports
   cross-device restore, but stores behavioral data and private navigation state
   that Phase 7 does not need, while turning pane focus and resize gestures into
   database writes.
4. **Add a typed identity overlay, owner-scoped reference/usage persistence, and
   bounded URL-serialized workspace state.** Existing tables remain authoritative;
   server projections expose only safe preview fields.

## Decision

Choose option 4.

### Canonical identity and resolution

`src/lib/entities/*` defines one provider-neutral `EntityRef` contract and a
registry for `note`, `task`, `agenda_task`, `person`, `signal`, `approval`,
`routine_run`, `account`, and `holding`.

- UUID-backed kinds use their existing owner-row UUID.
- `holding` uses a normalized uppercase symbol because the existing detail
  route and provider-partitioned holding rows converge on that identity.
- `task` means the durable `agent_tasks` record. `agenda_task` explicitly means
  the legacy Agenda `tasks` record; the two concepts are not silently merged.
- Existing module tables remain the content source of truth. Server resolvers
  use exact field allowlists and owner filters, return normalized summaries,
  and do not invoke live providers on the search or preview path.
- Holding summaries aggregate same-symbol provider rows, but never sum a
  mixed-currency cost basis.

Unified search ranks normalized local candidates with an inspectable combination
of text match, aggregate explicit usage, and freshness. Independent source
failures produce a visible partial-result contract instead of discarding healthy
results.

### References and usage

`entity_references` stores typed owner-scoped edges and backlinks.
`entity_usage` stores only aggregate counters/timestamps for explicit `direct`,
`search`, `command`, and `link` actions. It does not store raw queries, result
previews, entity content, provider payloads, or pane state.

Authenticated clients may select only their own rows and have no direct mutation
grant. Narrow `SECURITY DEFINER` RPCs derive `auth.uid()`, validate both endpoint
entities against their authoritative owner tables, use fixed empty
`search_path`s, and perform create/delete/usage mutations. Internal ownership
and cleanup functions are not executable by client roles. Deletion triggers
remove dangling references and usage rows.

### Workspace state and navigation

The `ws` query parameter carries deterministic base64url-encoded JSON containing
only canonical references, pane ids, widths, active focus, and bounded history.
Base64url is a transport encoding, not encryption; consequently no titles,
descriptions, content, queries, or provider data may enter the payload.

The topology has one primary module surface and at most two secondary evidence
panes. Each pane keeps at most 12 entries in each history direction, widths are
integer basis points, secondary panes may consume at most 72% of the frame in
total, and the encoded payload is capped at 4,096 characters.
Strict decoding rejects unknown versions, kinds, fields, duplicates, invalid
widths, and oversized state using safe error codes that never echo the payload.

Opening and closing a pane creates a browser history entry. Focus, pane-local
back/forward, navigation within a pane, and resize replace the current entry.
Unrelated query parameters are preserved, canonical and legacy route redirects
retain `ws`, and entity navigation carries the workspace forward. Durable Tasks
and Holdings have consuming entity-detail routes; kinds whose owning module
does not yet consume a canonical selection parameter navigate honestly to that
module rather than emitting a dead “selected record” link.
Compact layouts expose the same topology as keyboard-operable tabs; desktop
panes use a keyboard- and pointer-operable separator.

### Search and command integration

Search (`Cmd/Ctrl+/`) and commands (`Cmd/Ctrl+K`) are separate, mutually
exclusive dialogs. Search supports entity filters, partial/error states,
owner-checked hover previews, opening in a pane, opening the full page, and
creating a typed reference to the active pane. The secondary navigation action
is labeled “Open full page” only for a consuming entity-detail route and
otherwise names the owning module. Merely previewing a result does not increment
usage; explicit activation records exactly one usage action.

The command palette consumes a typed registry carrying scope, authentication
and ownership requirements, action class, execution kind, analytics event, and
contextual availability. Local pane commands are `READ` client actions. The
concentration routine remains an owner-checked `INTERNAL_WRITE`; navigation
occurs only after a valid success response, with visible failures and safe
Sentry metadata.

## Rationale

This design gives every module a stable cross-surface identity without replacing
its domain model or duplicating private content. URL state provides reload,
bookmark, browser-history, and cross-route behavior with no pane-state database
writes. Durable data is limited to user-authored relationships and aggregate
frecency signals, while authorization is re-established on the server for every
read and mutation.

Hard caps keep the URL and responsive workspace understandable. Separating
search from commands preserves clear intent: search selects an entity; commands
invoke a typed navigation, client action, or mutation with explicit policy
metadata.

## Consequences

- The migration `202607161200_entity_workspace.sql` must be applied before
  reference creation or frecency persistence can succeed. Search and previews
  still surface explicit partial/error states if those optional reads fail.
- Entity ids in `ws` are encoded but not secret. A copied URL can disclose the
  existence of opaque identifiers, never content; owner-scoped resolution
  prevents a foreign or stale reference from revealing a record.
- Two task identities intentionally coexist. Any module adopting canonical deep
  links must consume the serialized ref for its own kind rather than guessing
  from a bare UUID.
- Phase 7 does not add live-provider search, a universal content index, saved
  named workspaces, or more than two secondary panes. Those require separate
  privacy, latency, and product decisions.
- Production readiness still requires the normal Vercel preview workflow,
  post-preview Sentry regression review, and manual owner/RLS checks; this ADR
  records the architecture, not completion of those external gates.

## Reversal cost

Medium. The entity contracts and resolver projections are additive and existing
module tables remain authoritative. The shell can stop emitting `ws` without
data loss. Removing the feature requires retiring the two additive tables/RPCs
and their cleanup triggers after references and usage are exported or explicitly
discarded.
