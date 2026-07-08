"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { usePeople, personFootLabel, personIsDue, type Person, type PersonTag } from "@/lib/hooks/usePeople";
import { createClient } from "@/lib/supabase/client";
import { AddAccountPicker } from "@/components/mail/AddAccountPicker";
import { AddContactsPicker } from "./AddContactsPicker";

interface GoogleContact {
  id: string;
  name: string;
  email: string;
  phone: string;
}

type ContactSuggestion =
  | { contactId: string; type: "merge"; matchedPersonId: string; matchedPersonName: string; confidence: number }
  | { contactId: string; type: "add"; suggestedTag: PersonTag; reason: string };

const FILTERS = ["All", "Mentors", "Collaborators", "Friends", "Needs Follow-Up"] as const;

type Filter = (typeof FILTERS)[number];

type DemoPerson = {
  av: string;
  name: string;
  role: string;
  note: string;
  tag: "Mentor" | "Collaborator" | "Friend";
  foot: string;
  due: boolean;
};

// Signed-out demo content — signed-in users only ever see their real data
const DEMO_PEOPLE: DemoPerson[] = [
  {
    av: "A",
    name: "Dr. Adeyemi",
    role: "PI · Neurosurgery",
    note: "Owes you the IRB amendment sign-off. Last 1:1 covered cohort 2.",
    tag: "Mentor",
    foot: "Follow up · 2d",
    due: true,
  },
  {
    av: "R",
    name: "Riku Tanaka",
    role: "Co-author · Stats",
    note: "Sent the recurrence dataset; waiting on his Fine–Gray code review.",
    tag: "Collaborator",
    foot: "Last: 4d",
    due: false,
  },
  {
    av: "C",
    name: "Chidi O.",
    role: "Friend · Med school",
    note: "Mentioned visiting next month — reply to his text about dates.",
    tag: "Friend",
    foot: "Reply owed",
    due: true,
  },
  {
    av: "M",
    name: "Dr. Marsh",
    role: "Mentor · Program",
    note: "Offered to review your residency personal statement in July.",
    tag: "Mentor",
    foot: "Last: 2w",
    due: false,
  },
];

const TAG_LABELS: Record<PersonTag, string> = {
  mentor: "Mentor",
  collaborator: "Collaborator",
  friend: "Friend",
};

const TAG_BY_FILTER: Partial<Record<Filter, PersonTag>> = {
  Mentors: "mentor",
  Collaborators: "collaborator",
  Friends: "friend",
};

const EMPTY_FORM = {
  name: "",
  role: "",
  note: "",
  tag: "collaborator" as PersonTag,
  last_contact_on: "",
  follow_up_on: "",
};

const inputCls = "rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm";

export function PeopleModule() {
  const { toast } = useToast();
  const { people, loading, loadError, signedIn, addPerson, updatePerson, deletePerson } = usePeople();
  const supabase = useMemo(() => createClient(), []);
  const [filter, setFilter] = useState<Filter>("All");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [contacts, setContacts] = useState<GoogleContact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const matchedOnceRef = useRef(false);
  const [showMailPicker, setShowMailPicker] = useState(false);
  const mailBtnRef = useRef<HTMLDivElement>(null);
  const [showContactsPicker, setShowContactsPicker] = useState(false);
  const contactsBtnRef = useRef<HTMLDivElement>(null);

  const ensureFollowUpSignal = useCallback(async (person: Person) => {
    if (!personIsDue(person)) return false;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const metadata = { source_object_type: "person", source_object_id: person.id, source_route: "/people" };
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("user_id", user.id)
      .eq("source", "People")
      .contains("metadata", metadata)
      .maybeSingle();

    const payload = {
      user_id: user.id,
      title: `Follow up with ${person.name}`,
      body: person.note || person.role || null,
      source: "People",
      signal_type: "action",
      route_target: "people",
      metadata,
      read_at: null,
      routed_at: null,
    };

    if (existing?.id) {
      const { error } = await supabase.from("signals").update(payload).eq("id", existing.id);
      return !error;
    }
    const { error } = await supabase.from("signals").insert(payload);
    return !error;
  }, [supabase]);

  // Close mail picker on outside click
  useEffect(() => {
    if (!showMailPicker) return;
    const handler = (e: MouseEvent) => {
      if (mailBtnRef.current && !mailBtnRef.current.contains(e.target as Node)) {
        setShowMailPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMailPicker]);

  // Close contacts picker on outside click
  useEffect(() => {
    if (!showContactsPicker) return;
    const handler = (e: MouseEvent) => {
      if (contactsBtnRef.current && !contactsBtnRef.current.contains(e.target as Node)) {
        setShowContactsPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showContactsPicker]);

  const fetchContacts = useCallback(() => {
    setContactsError(null);
    fetch("/api/contacts/list")
      .then((r) => {
        if (!r.ok) throw new Error("contacts_unavailable");
        return r.json() as Promise<GoogleContact[]>;
      })
      .then((data: GoogleContact[] | null) => {
        if (data) setContacts(data);
        setContactsLoaded(true);
      })
      .catch(() => {
        setContactsError("Google Contacts could not be loaded.");
        setContactsLoaded(true);
      });
  }, []);

  // After connecting Google Contacts via Composio, the connection is often still
  // INITIATED on the first read — a one-shot fetch returns nothing and the CRM
  // looks like it didn't sync. Poll a few times (nudging Composio's poll-on-read
  // status so the connection flips ACTIVE) until contacts actually land.
  const refreshContactsAfterConnect = useCallback(() => {
    let tries = 0;
    const attempt = async () => {
      tries += 1;
      await fetch("/api/integrations/composio/status", { cache: "no-store" }).catch(() => {});
      const data = await fetch("/api/contacts/list")
        .then((r) => {
          if (!r.ok) throw new Error("contacts_unavailable");
          return r.json() as Promise<GoogleContact[]>;
        })
        .catch(() => {
          setContactsError("Google Contacts could not be loaded.");
          return null;
        });
      if (data && data.length > 0) {
        setContacts(data);
        setContactsError(null);
        setContactsLoaded(true);
        return;
      }
      if (tries < 4) setTimeout(attempt, 2500);
      else setContactsLoaded(true);
    };
    void attempt();
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!signedIn) {
      setContacts([]);
      setContactsLoaded(false);
      setContactsError(null);
      return;
    }
    fetchContacts();
  }, [fetchContacts, loading, signedIn]);

  // Dedupe/auto-tag suggestions for newly-synced contacts — runs once per
  // session against the CRM as it stood when contacts finished loading, not
  // on every poll (this is an AI-backed call, not a cheap status check).
  useEffect(() => {
    if (matchedOnceRef.current || loading || !contactsLoaded || contacts.length === 0) return;
    matchedOnceRef.current = true;
    setSuggestionsError(null);
    fetch("/api/people/match-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("match_unavailable");
        return r.json() as Promise<{ suggestions?: ContactSuggestion[] }>;
      })
      .then((data: { suggestions?: ContactSuggestion[] } | null) => setSuggestions(data?.suggestions ?? []))
      .catch(() => setSuggestionsError("Contact match suggestions are unavailable."));
  }, [loading, contactsLoaded, contacts]);

  const mergeContact = async (s: Extract<ContactSuggestion, { type: "merge" }>) => {
    const result = await updatePerson(s.matchedPersonId, { last_contact_on: new Date().toISOString().slice(0, 10) });
    if (result.error) { toast(result.error, "error", "People"); return; }
    toast(`Marked contact with ${s.matchedPersonName}.`, "success", "People");
    setSuggestions((prev) => prev.filter((x) => x.contactId !== s.contactId));
  };

  const addContactToCRM = (contact: GoogleContact, tag: PersonTag) => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, name: contact.name, tag });
    setModalOpen(true);
  };

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (p: Person) => {
    setEditing(p);
    setForm({
      name: p.name,
      role: p.role,
      note: p.note,
      tag: p.tag,
      last_contact_on: p.last_contact_on ?? "",
      follow_up_on: p.follow_up_on ?? "",
    });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast("Give the person a name.", "warn", "People");
      return;
    }
    const payload = {
      name: form.name.trim(),
      role: form.role.trim(),
      note: form.note.trim(),
      tag: form.tag,
      last_contact_on: form.last_contact_on || null,
      follow_up_on: form.follow_up_on || null,
    };
    const result = editing ? await updatePerson(editing.id, payload) : await addPerson(payload);
    if (result.error) {
      toast(result.error, "error", "People");
      return;
    }
    const routed = result.data ? await ensureFollowUpSignal(result.data) : false;
    toast(
      routed
        ? "Person saved and follow-up routed to Dispatch."
        : editing ? "Person updated." : "Person added.",
      "success",
      "People",
    );
    setModalOpen(false);
  };

  const remove = async () => {
    if (!editing) return;
    const confirmed = window.confirm(`Remove ${editing.name} from People?`);
    if (!confirmed) return;
    const result = await deletePerson(editing.id);
    if (result.error) toast(result.error, "error", "People");
    else toast("Person removed.", "info", "People");
    setModalOpen(false);
  };

  const visible = people.filter((p) => {
    if (filter === "All") return true;
    if (filter === "Needs Follow-Up") return personIsDue(p);
    return p.tag === TAG_BY_FILTER[filter];
  });

  const visibleDemo = DEMO_PEOPLE.filter((p) => {
    if (filter === "All") return true;
    if (filter === "Needs Follow-Up") return p.due;
    return `${p.tag}s` === filter;
  });

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div ref={mailBtnRef} style={{ position: "relative" }}>
          <div
            className="selectbox"
            style={{ cursor: "pointer" }}
            onClick={() => setShowMailPicker((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20a8 8 0 0 1 16 0" />
            </svg>
            Connect Mail
          </div>
          {showMailPicker && (
            <AddAccountPicker
              onClose={() => setShowMailPicker(false)}
              onConnected={(provider) => {
                toast(`${provider} mail connected`, "success", "People");
                setShowMailPicker(false);
              }}
            />
          )}
        </div>
        <div ref={contactsBtnRef} style={{ position: "relative" }}>
          <div
            className="selectbox"
            style={{ cursor: "pointer" }}
            onClick={() => setShowContactsPicker((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="9" cy="10" r="2" />
              <path d="M5 18a4 4 0 0 1 8 0" />
              <path d="M15 8h4M15 12h4" />
            </svg>
            Connect Contacts
          </div>
          {showContactsPicker && (
            <AddContactsPicker
              onClose={() => setShowContactsPicker(false)}
              onConnected={() => {
                toast("Google Contacts connected — syncing…", "success", "People");
                refreshContactsAfterConnect();
                setShowContactsPicker(false);
              }}
            />
          )}
        </div>
      </div>
      <div className="divider" />
      <div className="crm-toolbar">
        <button type="button" className="sig-go" onClick={openAdd}>+ Add Person</button>
        <div className="chips" style={{ margin: 0 }}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className={`chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="people-grid" style={{ pointerEvents: "none" }}>
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} rows={3} />)}
        </div>
      ) : loadError ? (
        <StatusCallout kind="error" title="People unavailable">{loadError}</StatusCallout>
      ) : !signedIn ? (
        <div className="people-grid">
          {visibleDemo.map((p) => (
            <div className="person" key={p.name}>
              <div className="ph">
                <div className="pav">{p.av}</div>
                <div>
                  <div className="pnm">{p.name}</div>
                  <div className="prl">{p.role}</div>
                </div>
              </div>
              <div className="pnote">{p.note}</div>
              <div className="pfoot">
                <span className="ptag">{p.tag}</span>
                {p.due ? <span className="due">{p.foot}</span> : <span>{p.foot}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : people.length === 0 ? (
        <div className="empty-state">
          <strong>No people yet</strong>
          <p>Add the mentors, collaborators, and friends you want to keep up with.</p>
        </div>
      ) : (
        <div className="people-grid">
          {visible.map((p) => (
            <div
              className="person"
              key={p.id}
              onClick={() => openEdit(p)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && openEdit(p)}
              style={{ cursor: "pointer" }}
              title="Click to edit"
            >
              <div className="ph">
                <div className="pav">{(p.name[0] ?? "?").toUpperCase()}</div>
                <div>
                  <div className="pnm">{p.name}</div>
                  <div className="prl">{p.role}</div>
                </div>
              </div>
              <div className="pnote">{p.note}</div>
              <div className="pfoot">
                <span className="ptag">{TAG_LABELS[p.tag]}</span>
                {personIsDue(p) ? (
                  <span className="due">{personFootLabel(p)}</span>
                ) : (
                  <span>{personFootLabel(p)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {contactsLoaded && contacts.length > 0 && (
        <>
          <div className="divider" style={{ marginTop: 20 }} />
          <div
            className="seclabel"
            style={{ marginTop: 12, marginBottom: 8 }}
          >
            Google Contacts
          </div>
          {suggestionsError && <p style={{ fontSize: 12, color: "var(--clay)", margin: "0 0 10px" }}>{suggestionsError}</p>}
          <div className="people-grid">
            {contacts.map((c) => {
              const suggestion = suggestions.find((s) => s.contactId === c.id);
              return (
                <div className="person" key={c.id}>
                  <div className="ph">
                    <div className="pav">{(c.name[0] ?? "?").toUpperCase()}</div>
                    <div>
                      <div className="pnm">{c.name}</div>
                      <div className="prl">{c.email}</div>
                    </div>
                  </div>
                  {suggestion && (
                    <div className="pfoot">
                      {suggestion.type === "merge" ? (
                        <button type="button" className="chip" onClick={() => mergeContact(suggestion)}>
                          Looks like {suggestion.matchedPersonName} — merge?
                        </button>
                      ) : (
                        <button type="button" className="chip" onClick={() => addContactToCRM(c, suggestion.suggestedTag)}>
                          Add to CRM as {TAG_LABELS[suggestion.suggestedTag]}?
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {signedIn && contactsLoaded && contactsError && (
        <p style={{ fontSize: 12, color: "var(--clay)", marginTop: 12 }}>{contactsError}</p>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit person" : "Add person"}
        footer={
          <>
            {editing && (
              <Button variant="danger" onClick={remove}>
                Remove
              </Button>
            )}
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Role — e.g. PI · Neurosurgery"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          />
          <textarea
            className={inputCls}
            placeholder="Note — what's open between you?"
            rows={3}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <select
            className={inputCls}
            value={form.tag}
            onChange={(e) => setForm({ ...form, tag: e.target.value as PersonTag })}
          >
            <option value="mentor">Mentor</option>
            <option value="collaborator">Collaborator</option>
            <option value="friend">Friend</option>
          </select>
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-[var(--ink-faint)]">
            Last contact
            <input
              type="date"
              className={inputCls}
              value={form.last_contact_on}
              onChange={(e) => setForm({ ...form, last_contact_on: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-[var(--ink-faint)]">
            Follow up on
            <input
              type="date"
              className={inputCls}
              value={form.follow_up_on}
              onChange={(e) => setForm({ ...form, follow_up_on: e.target.value })}
            />
          </label>
        </div>
      </Modal>
    </>
  );
}
