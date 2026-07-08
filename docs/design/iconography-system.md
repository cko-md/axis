# AXIS Iconography System

> Baseline: **Lucide** via `src/components/ui/Icon.tsx` and `src/lib/icons/nav-icons.ts`

---

## Icon library

| Layer | Source | Status |
|-------|--------|--------|
| Nav / command palette | Lucide semantic map | ✅ Batch 1 |
| Status badges | CSS + text labels | Existing `--status-*` tokens |
| Widget actions | Inline SVG | 🔄 Migrate Batch 2 |
| Presence mascots | Custom SVG | Keep (brand) |
| Provider logos | Custom / text | Keep per provider |

---

## Size rules

| Token | px | Use |
|-------|-----|-----|
| `xs` | 14 | Inline metadata, compact badges |
| `sm` | 16 | Nav, toolbar (default) |
| `md` | 18 | Module headers, widget actions |
| `lg` | 22 | Empty states, hero affordances |

---

## Stroke rules

- Default `strokeWidth={1.6}` — matches legacy nav SVG weight
- Optical alignment: `shrink-0` on Icon wrapper
- Color: `currentColor` — inherits `--ink`, `--ink-dim`, or `--accent`

---

## Color / token rules

| Context | Color |
|---------|-------|
| Default nav | `currentColor` → `--ink-dim` / active `--accent` |
| Destructive | `--down` / `--clay` |
| Status live | `--status-live` |
| Status error | `--status-error` |
| Status lab | `--status-lab` |
| Status disconnected | `--status-disconnected` |

---

## Hit area rules

- Minimum 44×44px touch target for icon-only buttons
- Nav items: full row clickable, icon decorative (`aria-hidden`)
- Icon-only controls require `label` prop on `Icon` or parent `aria-label`

---

## Accessibility rules

1. Decorative icons: `aria-hidden` (default when no `label`)
2. Meaningful icons: `label` prop → `role="img"` + `aria-label`
3. Never icon-only destructive actions without confirm + label
4. Focus ring: `--focus-ring` on interactive parents

---

## Module icon mapping

| Nav key | Lucide | Module |
|---------|--------|--------|
| `console` | LayoutDashboard | Command |
| `signals` | Radio | Dispatch |
| `calendar` | Calendar | Schedule |
| `agenda` | ListTodo | Agenda |
| `mail` | Mail | Mail |
| `notes` | ClipboardList | Notes |
| `goals` | Target | Objectives |
| `review` | RotateCcw | Debrief |
| `pipeline` | GitBranch | Pipeline |
| `literature` | BookOpen | Literature |
| `fitness` | Dumbbell | Vitality |
| `atelier` | Paintbrush | Atelier |
| `people` | Users | People |
| `briefing` | Newspaper | Briefing |
| `vault` | Music2 | Listening Vault |
| `library` | FolderOpen | Library |
| `recipes` | ChefHat | Supper Club |
| `chart` | LineChart | Fund |
| `system` | Settings | Control Room |

---

## Status icon mapping (planned Batch 2)

| State | Lucide (proposed) |
|-------|-------------------|
| live | `CircleDot` |
| loading | `Loader2` |
| stale | `Clock` |
| error | `AlertCircle` |
| lab | `FlaskConical` |
| disconnected | `Unplug` |
| local-only | `HardDrive` |

---

## Action icon mapping (planned)

| Action | Lucide |
|--------|--------|
| refresh | `RefreshCw` |
| external | `ExternalLink` |
| dispatch/route | `ArrowRight` |
| archive | `Archive` |
| delete | `Trash2` |
| reply | `Reply` |

---

## Custom icon exceptions

| Asset | Reason to keep custom |
|-------|----------------------|
| Axiom monolith SVG | Brand presence character |
| Codex deck SVG | Brand presence character |
| Nova orbital SVG | Brand presence character |
| AXIS sidebar logo | Wordmark / brand |

---

## Migration status

- [x] `Icon` primitive
- [x] Nav sidebar Lucide
- [ ] Command palette icons
- [ ] Widget shell actions
- [ ] Status callout icons
- [ ] Module inline SVG audit (~30 files)
