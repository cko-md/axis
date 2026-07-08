# Cross-Module Workflow Validation

> End-to-end chains to verify as patches land. Status as of Batch 0.

---

## Chain 1: Capture → Dispatch → Agenda → Schedule → Notes

| Step | Route | Status | Gap |
|------|-------|--------|-----|
| Console capture | `/command` | ✅ | Creates signal |
| Open signal | `/dispatch` | ✅ | Detail + routing |
| Route to task | `/agenda` | ✅ | Task created |
| Schedule block | `/schedule` | ✅ | Event CRUD |
| Reference in note | `/notes` | ✅ | Manual link |

---

## Chain 2: Mail → Dispatch → follow-up

| Step | Status | Gap |
|------|--------|-----|
| List inbox | ✅ | Per-account errors in JSON |
| Open detail | ~ | Composio multi-account |
| Route to Dispatch | ✅ | MessagePanel action |
| Create task/person | ✅ | Signal routes |

---

## Chain 3: Literature → Pipeline → Debrief

| Step | Status | Gap |
|------|--------|-----|
| Search sources | ✅ | Provider failures surfaced |
| Save paper | ~ | localStorage fallback path |
| Pipeline item | ✅ | Study CRUD |
| Debrief reference | ~ | Shallow detail |

---

## Chain 4: Interface Studio → shell rendering

| Step | Status | Gap |
|------|--------|-----|
| Open Studio | ✅ | Drawer + focus trap |
| Change theme | ✅ | Instant `html` class |
| Change accent | ✅ | CSS var override |
| Signed-in sync | ✅ | `user_preferences` |
| Reset | ✅ | Confirm dialog |
| Notifications | ~ | **Labeled honest Batch 1** — no delivery yet |

---

## Chain 5: Presence → AI → privacy

| Step | Status | Gap |
|------|--------|-----|
| Show companion | ✅ | |
| Send prompt | ✅ | `/api/ai` |
| Error fallback | ✅ | Local message |
| Sentry on failure | ~ | Client capture partial |
| Privacy disclosure | ~ | P2 — no inline badge |

---

## Chain 6: Control Room → module disconnected state

| Step | Status | Gap |
|------|--------|-----|
| Provider health panel | ✅ | 19 fetches |
| Mail disconnected | ✅ | Setup state |
| Reconnect flow | ✅ | Composio OAuth |

---

## Chain 7: Fund widget → detail

| Step | Status | Gap |
|------|--------|-----|
| Console markets widget | ✅ | |
| Click to Fund | ~ | Widget not clickable P2 |
| Quote freshness | ✅ | Stale labels |

---

## Validation schedule

- Batch 4: Chain 2 (Mail parity)
- Batch 5: Chain 3 (Literature)
- Batch 7: Vitality persistence
- Batch 9: Full matrix manual pass on Vercel preview
