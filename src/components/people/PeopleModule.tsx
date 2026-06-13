"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { usePeople, personFootLabel, personIsDue, type Person, type PersonTag } from "@/lib/hooks/usePeople";

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
  const { people, loading, signedIn, addPerson, updatePerson, deletePerson } = usePeople();
  const [filter, setFilter] = useState<Filter>("All");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

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
    toast(editing ? "Person updated." : "Person added.", "success", "People");
    setModalOpen(false);
  };

  const remove = async () => {
    if (!editing) return;
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
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
        <div className="selectbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20a8 8 0 0 1 16 0" />
          </svg>
          Connect Contacts &amp; Mail
        </div>
      </div>
      <h1 className="hero">People</h1>
      <p className="sub">Mentors, collaborators, friends — and who to follow up with.</p>
      <div className="divider" />
      <div className="crm-toolbar">
        <button type="button" className="sig-go" onClick={openAdd}>+ Add Person</button>
        <div className="chips" style={{ margin: 0 }}>
          {FILTERS.map((f) => (
            <span key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </span>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Loading people…</div>
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
