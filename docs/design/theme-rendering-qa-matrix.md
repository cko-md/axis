# Theme Rendering QA Matrix

> Validate representative combinations per release batch. Mark ✅ when exercised.

---

## Themes × routes

| Route | dark | dim | slate | light (chrome) |
|-------|------|-----|-------|----------------|
| `/` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/command` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/mail` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/notes` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/fund` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/control-room` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/literature` | ⏭ | ⏭ | ⏭ | ⏭ |
| `/vitality` | ⏭ | ⏭ | ⏭ | ⏭ |

---

## Accent presets (on dark + light)

| Preset | Command | Mail reader | Widget shell |
|--------|---------|-------------|--------------|
| gold | ⏭ | ⏭ | ⏭ |
| marine | ⏭ | ⏭ | ⏭ |
| clay | ⏭ | ⏭ | ⏭ |
| chrome | ⏭ | ⏭ | ⏭ |

---

## Density

| Mode | Agenda list | Console grid | Notes editor |
|------|-------------|--------------|--------------|
| compact | ⏭ | ⏭ | ⏭ |
| default | ⏭ | ⏭ | ⏭ |
| cozy | ⏭ | ⏭ | ⏭ |

---

## Font pairings

| Display | Body | Dense module test |
|---------|------|-------------------|
| Instrument (Fraunces) | Archivo | ⏭ `/mail` |
| Editorial (Playfair) | Inter | ⏭ `/fund` |
| Grotesk (Space Grotesk) | IBM Plex | ⏭ `/command` |

---

## Presence

| Form | dark | light | reduced-motion |
|------|------|-------|----------------|
| hidden | ⏭ | ⏭ | ⏭ |
| Axiom | ⏭ | ⏭ | ⏭ |
| Codex | ⏭ | ⏭ | ⏭ |
| Nova | ⏭ | ⏭ | ⏭ |

---

## Motion

| Check | Expected |
|-------|----------|
| `prefers-reduced-motion: reduce` | Aurora/wash animations off |
| Normal | Depth field animates |
| Interface Studio open | No layout flash |

---

## Icon system (Batch 1+)

| Check | Expected |
|-------|----------|
| Nav icons Lucide | Stroke 1.6, aligned in sidebar |
| Active nav | Accent color on icon + label |
| Icon-only close buttons | aria-label present |

---

## Automated coverage

- `src/components/phase5-theme-qa.test.ts`
- `src/components/mail/theme-qa.test.ts`
- `src/components/console/console-theme-qa.test.ts`
- `src/components/notes/theme-qa.test.ts`

Run: `npm run test -- theme-qa`

---

## Batch 1 partial validation

| Check | Result |
|-------|--------|
| `--axis-*` tokens in `:root` | ✅ Static review |
| Nova uses `--companion-nova-*` | ✅ Code review |
| Nav Lucide icons compile | ⏭ Pending tsc |
