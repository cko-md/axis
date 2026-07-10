# Apps — New Board plan

## Goal

Let users group sidebar URL modules into named boards (workspaces) without pretending drag-and-drop is fully shipped.

## Phase 1 (shipped) — scaffold + assignment

- **Create board** modal from sidebar "New Board" action
- Persist boards in `localStorage` (`axis-url-boards`)
- List boards under Apps
- **Assign modules** via drag-and-drop zones + checkboxes in board detail modal (exclusive per board)
- Reorder modules within a board via drag

## Phase 2 — board builder

- Drag URL modules onto board rows in the sidebar (without opening the modal)
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
- User can drag modules between Assigned / Available zones (and reorder on board)
- No fake "synced" label — local-only until Phase 3
