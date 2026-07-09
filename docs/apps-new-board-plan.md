# Apps — New Board plan

## Goal

Let users group sidebar URL modules into named boards (workspaces) without pretending drag-and-drop is fully shipped.

## Phase 1 (this PR) — scaffold

- **Create board** modal from sidebar "New Board" action
- Persist boards in `localStorage` (`axis-url-boards`)
- List boards under Apps with honest "scaffold" label
- Opening a board shows placeholder state + linked URL modules count

## Phase 2 — board builder

- Drag URL modules between boards (dnd-kit, same pattern as Atelier moodboard)
- Reorder modules within a board
- Default board for unassigned modules
- Board-level icon/color

## Phase 3 — persistence + sync

- Supabase `url_boards` table (user_id, name, module_ids jsonb, sort_order)
- RLS owner-scoped; migrate from localStorage on first sign-in
- Realtime refresh across devices

## Phase 4 — deep integration

- Open board as filtered Apps view in sidebar
- ⌘K commands: "Switch to board …", "Move module to board …"
- Optional: board opens as Command widget layout preset

## Non-goals (for now)

- Full iframe grid layout editor
- Cross-user shared boards
- Replacing native AXIS modules with boards

## Acceptance for Phase 1

- New Board creates a persisted row and surfaces it in Apps
- User sees explicit scaffold/coming-soon for drag-and-drop
- No fake "synced" label — local-only until Phase 3
