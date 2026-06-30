# Widget Motion

WID-MOTION-1 adds semantic motion to the reusable widget primitives without redesigning the Console.

## Scope

- `WidgetShell` owns widget-level state transitions for hover, tap, refresh, stale, error, and value updates.
- `WidgetStatusBadge` owns lightweight status feedback for loading, refreshing, and error states.
- `WidgetDetailDrawer` owns drawer entrance motion while preserving Escape close and focus management.
- `ConsoleModule` keeps dnd-kit as the source of truth for drag behavior and only adds safe layout-position animation when a block is not actively being dragged.

## Motion Rules

- Motion must communicate state, not decorate the page.
- Refreshing widgets may rotate the icon and pulse the status badge.
- Fresh value updates may fade/settle into place.
- Error states may pulse the badge and strengthen the border, but should not loop aggressively.
- Drawer motion should be short, directional, and reduced-motion-safe.
- Layout motion must not run during active drag because dnd-kit owns transforms then.

## Reduced Motion

The implementation uses `useReducedMotion` from Motion for React. When reduced motion is requested:

- Initial entrance animations are disabled.
- Widget icon rotation is disabled.
- Status badge pulse is disabled.
- Drawer entrance animation is disabled.
- Layout-position animation is disabled.

CSS transitions for simple color changes remain unless explicitly disabled by the reduced-motion media query.

## Data and Observability

No database schema changes were made. Supabase widget cache behavior is unchanged.

Tembo impact: no change. Tembo role is unspecified in inspected repo config.

No new Sentry capture path is required for this phase because the change is presentational. Existing widget data and provider error reporting remain responsible for provider failures.
