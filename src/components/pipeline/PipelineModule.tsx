"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  usePipeline,
  CONFERENCE_STATUS_LABELS,
  type Conference,
  type ConferenceStatus,
  type PipelineStage,
  type Study,
} from "@/lib/hooks/usePipeline";

type DemoStudy = {
  role: string;
  title: string;
  meta: React.ReactNode;
  next: string;
  nextIcon: "plus" | "check";
};

type DemoColumn = {
  swatch: string;
  name: string;
  studies: DemoStudy[];
};

// Signed-out demo content — signed-in users only ever see their real data
const DEMO_COLUMNS: DemoColumn[] = [
  {
    swatch: "var(--ink-faint)",
    name: "Ideation",
    studies: [
      {
        role: "First Author",
        title: "Connectomic Predictors of DBS Response — Scoping Review",
        meta: <span><b>Type:</b> Systematic review</span>,
        next: "Draft PICO",
        nextIcon: "plus",
      },
      {
        role: "Co-author",
        title: "ML Triage for ICH Expansion Risk",
        meta: <span><b>Type:</b> Retrospective</span>,
        next: "Scope feasibility",
        nextIcon: "plus",
      },
    ],
  },
  {
    swatch: "var(--clay)",
    name: "IRB / Regulatory",
    studies: [
      {
        role: "First Author",
        title: "Endovascular vs. Microsurgical — UIA Cohort",
        meta: (
          <>
            <span><b>IRB:</b> Amendment pending</span>
            <span className="deadline">⚠ expires 22 Jun</span>
          </>
        ),
        next: "File continuing review",
        nextIcon: "check",
      },
    ],
  },
  {
    swatch: "var(--accent)",
    name: "Data / Analysis",
    studies: [
      {
        role: "First Author",
        title: "Recurrence After Resection — Survival Analysis",
        meta: (
          <>
            <span><b>Stage:</b> Cox PH modeling</span>
            <span><b>n:</b> 247</span>
          </>
        ),
        next: "Check PH assumption",
        nextIcon: "check",
      },
      {
        role: "Co-author",
        title: "Opioid-Sparing Protocol — Spine",
        meta: <span><b>Stage:</b> Collection 80%</span>,
        next: "Finish review",
        nextIcon: "check",
      },
    ],
  },
  {
    swatch: "var(--up)",
    name: "Drafting",
    studies: [
      {
        role: "First Author",
        title: "DBS Outcomes & Network Modulation",
        meta: (
          <>
            <span><b>Target:</b> Neurosurgery</span>
            <span className="deadline">edits due 18:00</span>
          </>
        ),
        next: "Finalize Discussion",
        nextIcon: "check",
      },
    ],
  },
  {
    swatch: "var(--down)",
    name: "Under Review",
    studies: [
      {
        role: "First Author",
        title: "Timing of Decompression — Meta-analysis",
        meta: (
          <>
            <span><b>JNS</b> · R&amp;R</span>
            <span><b>Due:</b> 09 Jun</span>
          </>
        ),
        next: "Address reviewer 2",
        nextIcon: "check",
      },
    ],
  },
];

const DEMO_CONFERENCES = [
  {
    name: "AANS Annual Meeting 2026",
    loc: "Los Angeles · Apr 18–22",
    badge: "accepted",
    badgeLabel: "Accepted",
    tick: true,
    rows: [
      ["Abstract", "Endovascular vs. Microsurgical — UIA"],
      ["Linked study", "UIA Cohort →"],
      ["Travel", "Flights booked · hotel pending"],
      ["Next", "Poster print by Apr 10"],
    ],
  },
  {
    name: "CNS Annual Meeting 2026",
    loc: "Chicago · Oct 12–16",
    badge: "open",
    badgeLabel: "Abstract Due",
    tick: false,
    rows: [
      ["Deadline", "Jun 28 · in 27 days"],
      ["Planned", "DBS Outcomes & Network Modulation"],
      ["Linked study", "DBS Manuscript →"],
      ["Travel", "Not yet booked"],
    ],
  },
  {
    name: "Sano Symposium",
    loc: "Boston · Jul 9",
    badge: "invited",
    badgeLabel: "Invited",
    tick: false,
    rows: [
      ["Role", "Lightning talk · 10 min"],
      ["Linked study", "Decompression Meta-analysis →"],
      ["Travel", "Train · day trip"],
      ["Next", "Slides by Jul 1"],
    ],
  },
];

const BADGE_CLASS: Record<ConferenceStatus, string> = {
  accepted: "accepted",
  abstract_due: "open",
  invited: "invited",
  planned: "open",
};

const SWATCH_OPTIONS = [
  { value: "var(--ink-faint)", label: "Grey" },
  { value: "var(--clay)", label: "Clay" },
  { value: "var(--accent)", label: "Teal" },
  { value: "var(--up)", label: "Green" },
  { value: "var(--down)", label: "Red" },
];

const EMPTY_STUDY_FORM = {
  title: "",
  role: "First Author" as Study["role"],
  meta: "",
  next_action: "",
  stage_id: "",
};

const EMPTY_CONF_FORM = {
  name: "",
  location: "",
  date_label: "",
  status: "planned" as ConferenceStatus,
  abstract: "",
  travel: "",
  next_step: "",
  linked_study_id: "",
};

const inputCls = "rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm";

function NextIcon({ kind }: { kind: "plus" | "check" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      {kind === "plus" ? <path d="M12 5v14M5 12h14" /> : <path d="M5 12l5 5L20 7" />}
    </svg>
  );
}

export function PipelineModule() {
  const { toast } = useToast();
  const {
    stages,
    studies,
    conferences,
    loading,
    signedIn,
    addStage,
    deleteStage,
    addStudy,
    updateStudy,
    deleteStudy,
    addConference,
    updateConference,
    deleteConference,
  } = usePipeline();

  const [studyModalOpen, setStudyModalOpen] = useState(false);
  const [editingStudy, setEditingStudy] = useState<Study | null>(null);
  const [studyForm, setStudyForm] = useState(EMPTY_STUDY_FORM);
  const [stageModalOpen, setStageModalOpen] = useState(false);
  const [stageForm, setStageForm] = useState({ name: "", swatch: "var(--accent)" });
  const [pendingDeleteStage, setPendingDeleteStage] = useState<PipelineStage | null>(null);
  const [confModalOpen, setConfModalOpen] = useState(false);
  const [editingConf, setEditingConf] = useState<Conference | null>(null);
  const [confForm, setConfForm] = useState(EMPTY_CONF_FORM);

  const openAddStudy = (stageId: string) => {
    setEditingStudy(null);
    setStudyForm({ ...EMPTY_STUDY_FORM, stage_id: stageId });
    setStudyModalOpen(true);
  };

  const openEditStudy = (s: Study) => {
    setEditingStudy(s);
    setStudyForm({ title: s.title, role: s.role, meta: s.meta, next_action: s.next_action, stage_id: s.stage_id });
    setStudyModalOpen(true);
  };

  const saveStudy = async () => {
    if (!studyForm.title.trim()) {
      toast("Give the study a title.", "warn", "Pipeline");
      return;
    }
    const payload = {
      title: studyForm.title.trim(),
      role: studyForm.role,
      meta: studyForm.meta.trim(),
      next_action: studyForm.next_action.trim(),
      stage_id: studyForm.stage_id,
    };
    const result = editingStudy ? await updateStudy(editingStudy.id, payload) : await addStudy(payload);
    if (result.error) {
      toast(result.error, "error", "Pipeline");
      return;
    }
    toast(editingStudy ? "Study updated." : "Study added.", "success", "Pipeline");
    setStudyModalOpen(false);
  };

  const removeStudy = async () => {
    if (!editingStudy) return;
    const result = await deleteStudy(editingStudy.id);
    if (result.error) toast(result.error, "error", "Pipeline");
    else toast("Study removed.", "info", "Pipeline");
    setStudyModalOpen(false);
  };

  const saveStage = async () => {
    if (!stageForm.name.trim()) {
      toast("Give the stage a name.", "warn", "Pipeline");
      return;
    }
    if (!signedIn) {
      toast("Sign in to customize stages.", "warn", "Pipeline");
      return;
    }
    const result = await addStage(stageForm.name.trim(), stageForm.swatch);
    if (result.error) {
      toast(result.error, "error", "Pipeline");
      return;
    }
    toast("Stage added.", "success", "Pipeline");
    setStageModalOpen(false);
    setStageForm({ name: "", swatch: "var(--accent)" });
  };

  const confirmDeleteStage = async () => {
    if (!pendingDeleteStage) return;
    const result = await deleteStage(pendingDeleteStage.id);
    if (result.error) toast(result.error, "error", "Pipeline");
    else toast("Stage removed.", "info", "Pipeline");
    setPendingDeleteStage(null);
  };

  const openAddConf = () => {
    if (!signedIn) {
      toast("Sign in to track conferences.", "warn", "Pipeline");
      return;
    }
    setEditingConf(null);
    setConfForm(EMPTY_CONF_FORM);
    setConfModalOpen(true);
  };

  const openEditConf = (c: Conference) => {
    setEditingConf(c);
    setConfForm({
      name: c.name,
      location: c.location,
      date_label: c.date_label,
      status: c.status,
      abstract: c.abstract,
      travel: c.travel,
      next_step: c.next_step,
      linked_study_id: c.linked_study_id ?? "",
    });
    setConfModalOpen(true);
  };

  const saveConf = async () => {
    if (!confForm.name.trim()) {
      toast("Give the conference a name.", "warn", "Pipeline");
      return;
    }
    const payload = {
      name: confForm.name.trim(),
      location: confForm.location.trim(),
      date_label: confForm.date_label.trim(),
      status: confForm.status,
      abstract: confForm.abstract.trim(),
      travel: confForm.travel.trim(),
      next_step: confForm.next_step.trim(),
      linked_study_id: confForm.linked_study_id || null,
    };
    const result = editingConf ? await updateConference(editingConf.id, payload) : await addConference(payload);
    if (result.error) {
      toast(result.error, "error", "Pipeline");
      return;
    }
    toast(editingConf ? "Conference updated." : "Conference added.", "success", "Pipeline");
    setConfModalOpen(false);
  };

  const removeConf = async () => {
    if (!editingConf) return;
    const result = await deleteConference(editingConf.id);
    if (result.error) toast(result.error, "error", "Pipeline");
    else toast("Conference removed.", "info", "Pipeline");
    setConfModalOpen(false);
  };

  const studyName = (id: string | null) => studies.find((s) => s.id === id)?.title ?? null;


  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <button type="button" className="savebtn" onClick={() => setStageModalOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3" />
            <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.4-2.5h-4l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.07-.3.1-.6.1-1z" />
          </svg>
          Customize Stages
        </button>
      </div>

      {loading ? (
        <div className="empty-state">Loading pipeline…</div>
      ) : !signedIn ? (
        <div className="board">
          {DEMO_COLUMNS.map((col) => (
            <div key={col.name} className="col">
              <div className="col-h">
                <span className="swatch" style={{ background: col.swatch }} />
                <span className="ct">{col.name}</span>
                <span className="cn">{col.studies.length}</span>
                <span className="cmenu">⋯</span>
              </div>
              <div className="col-body">
                {col.studies.map((s) => (
                  <div key={s.title} className="study">
                    <div className="srole">{s.role}</div>
                    <div className="stitle">{s.title}</div>
                    <div className="smeta">{s.meta}</div>
                    <div className="next">
                      <NextIcon kind={s.nextIcon} />
                      {s.next}
                    </div>
                  </div>
                ))}
                <div className="addcard">+ Add Study</div>
              </div>
            </div>
          ))}
          <div className="addcol">+ Add Stage</div>
        </div>
      ) : (
        <div className="board">
          {stages.map((stage) => {
            const stageStudies = studies.filter((s) => s.stage_id === stage.id);
            return (
              <div key={stage.id} className="col">
                <div className="col-h">
                  <span className="swatch" style={{ background: stage.swatch }} />
                  <span className="ct">{stage.name}</span>
                  <span className="cn">{stageStudies.length}</span>
                  <span
                    className="cmenu"
                    role="button"
                    tabIndex={0}
                    title="Remove stage"
                    style={{ cursor: "pointer" }}
                    onClick={() => setPendingDeleteStage(stage)}
                    onKeyDown={(e) => e.key === "Enter" && setPendingDeleteStage(stage)}
                  >
                    ✕
                  </span>
                </div>
                <div className="col-body">
                  {stageStudies.map((s) => (
                    <div
                      key={s.id}
                      className="study"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      title="Click to edit"
                      onClick={() => openEditStudy(s)}
                      onKeyDown={(e) => e.key === "Enter" && openEditStudy(s)}
                    >
                      <div className="srole">{s.role}</div>
                      <div className="stitle">{s.title}</div>
                      {s.meta && <div className="smeta"><span>{s.meta}</span></div>}
                      {s.next_action && (
                        <div className="next">
                          <NextIcon kind="check" />
                          {s.next_action}
                        </div>
                      )}
                    </div>
                  ))}
                  <div
                    className="addcard"
                    role="button"
                    tabIndex={0}
                    onClick={() => openAddStudy(stage.id)}
                    onKeyDown={(e) => e.key === "Enter" && openAddStudy(stage.id)}
                  >
                    + Add Study
                  </div>
                </div>
              </div>
            );
          })}
          <div
            className="addcol"
            role="button"
            tabIndex={0}
            onClick={() => setStageModalOpen(true)}
            onKeyDown={(e) => e.key === "Enter" && setStageModalOpen(true)}
          >
            + Add Stage
          </div>
        </div>
      )}

      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 6 }}>
        Conferences, Abstracts &amp; Travel<span className="rule" /><span className="count">Feeds Pipeline</span>
      </h2>

      {loading ? null : !signedIn ? (
        <div className="conf-grid">
          {DEMO_CONFERENCES.map((c) => (
            <div key={c.name} className={`card conf${c.tick ? " tick" : ""}`}>
              <div className="conf-h">
                <div>
                  <div className="conf-n">{c.name}</div>
                  <div className="conf-loc">{c.loc}</div>
                </div>
                <span className={`conf-badge ${c.badge}`}>{c.badgeLabel}</span>
              </div>
              {c.rows.map(([k, v]) => (
                <div className="conf-row" key={k}>
                  <span className="conf-k">{k}</span>
                  <span className={`conf-v${k === "Linked study" ? " accent" : ""}`}>{v}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="card conf add-conf" role="button" tabIndex={0} onClick={openAddConf}>
            <div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 22, height: 22, color: "var(--accent)" }}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", marginTop: 8 }}>
                Add Conference
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="conf-grid">
          {conferences.map((c) => (
            <div
              key={c.id}
              className={`card conf${c.status === "accepted" ? " tick" : ""}`}
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              title="Click to edit"
              onClick={() => openEditConf(c)}
              onKeyDown={(e) => e.key === "Enter" && openEditConf(c)}
            >
              <div className="conf-h">
                <div>
                  <div className="conf-n">{c.name}</div>
                  <div className="conf-loc">{c.location}{c.location && c.date_label ? " · " : ""}{c.date_label}</div>
                </div>
                <span className={`conf-badge ${BADGE_CLASS[c.status]}`}>{CONFERENCE_STATUS_LABELS[c.status]}</span>
              </div>
              {c.abstract && (
                <div className="conf-row"><span className="conf-k">Abstract</span><span className="conf-v">{c.abstract}</span></div>
              )}
              {c.linked_study_id && studyName(c.linked_study_id) && (
                <div className="conf-row"><span className="conf-k">Linked study</span><span className="conf-v accent">{studyName(c.linked_study_id)} →</span></div>
              )}
              {c.travel && (
                <div className="conf-row"><span className="conf-k">Travel</span><span className="conf-v">{c.travel}</span></div>
              )}
              {c.next_step && (
                <div className="conf-row"><span className="conf-k">Next</span><span className="conf-v">{c.next_step}</span></div>
              )}
            </div>
          ))}
          <div className="card conf add-conf" role="button" tabIndex={0} onClick={openAddConf} onKeyDown={(e) => e.key === "Enter" && openAddConf()}>
            <div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 22, height: 22, color: "var(--accent)" }}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", marginTop: 8 }}>
                Add Conference
              </div>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={studyModalOpen}
        onClose={() => setStudyModalOpen(false)}
        title={editingStudy ? "Edit study" : "Add study"}
        footer={
          <>
            {editingStudy && <Button variant="danger" onClick={removeStudy}>Remove</Button>}
            <Button variant="ghost" onClick={() => setStudyModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveStudy}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Study title"
            aria-label="Study title"
            value={studyForm.title}
            onChange={(e) => setStudyForm({ ...studyForm, title: e.target.value })}
          />
          <select
            className={inputCls}
            aria-label="Role"
            value={studyForm.role}
            onChange={(e) => setStudyForm({ ...studyForm, role: e.target.value as Study["role"] })}
          >
            <option value="First Author">First Author</option>
            <option value="Co-author">Co-author</option>
          </select>
          <select
            className={inputCls}
            aria-label="Stage"
            value={studyForm.stage_id}
            onChange={(e) => setStudyForm({ ...studyForm, stage_id: e.target.value })}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            className={inputCls}
            placeholder="Meta — e.g. Type: Retrospective · n: 247"
            aria-label="Study meta"
            value={studyForm.meta}
            onChange={(e) => setStudyForm({ ...studyForm, meta: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Next action"
            aria-label="Next action"
            value={studyForm.next_action}
            onChange={(e) => setStudyForm({ ...studyForm, next_action: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={stageModalOpen}
        onClose={() => setStageModalOpen(false)}
        title="Add stage"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStageModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveStage}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Stage name — e.g. Revision"
            aria-label="Stage name"
            value={stageForm.name}
            onChange={(e) => setStageForm({ ...stageForm, name: e.target.value })}
          />
          <select
            className={inputCls}
            aria-label="Stage color"
            value={stageForm.swatch}
            onChange={(e) => setStageForm({ ...stageForm, swatch: e.target.value })}
          >
            {SWATCH_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </Modal>

      <Modal
        open={!!pendingDeleteStage}
        onClose={() => setPendingDeleteStage(null)}
        title="Remove stage"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDeleteStage(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDeleteStage}>Remove</Button>
          </>
        }
      >
        {pendingDeleteStage && (
          <p style={{ fontSize: 13, color: "var(--ink-dim)" }}>
            Remove <strong style={{ color: "var(--ink)" }}>{pendingDeleteStage.name}</strong>? Studies in this stage
            ({studies.filter((s) => s.stage_id === pendingDeleteStage.id).length}) will be deleted with it.
          </p>
        )}
      </Modal>

      <Modal
        open={confModalOpen}
        onClose={() => setConfModalOpen(false)}
        title={editingConf ? "Edit conference" : "Add conference"}
        footer={
          <>
            {editingConf && <Button variant="danger" onClick={removeConf}>Remove</Button>}
            <Button variant="ghost" onClick={() => setConfModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveConf}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Conference name"
            aria-label="Conference name"
            value={confForm.name}
            onChange={(e) => setConfForm({ ...confForm, name: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Location — e.g. Chicago"
            aria-label="Location"
            value={confForm.location}
            onChange={(e) => setConfForm({ ...confForm, location: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Dates — e.g. Oct 12–16"
            aria-label="Dates"
            value={confForm.date_label}
            onChange={(e) => setConfForm({ ...confForm, date_label: e.target.value })}
          />
          <select
            className={inputCls}
            aria-label="Status"
            value={confForm.status}
            onChange={(e) => setConfForm({ ...confForm, status: e.target.value as ConferenceStatus })}
          >
            {Object.entries(CONFERENCE_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input
            className={inputCls}
            placeholder="Abstract title"
            aria-label="Abstract title"
            value={confForm.abstract}
            onChange={(e) => setConfForm({ ...confForm, abstract: e.target.value })}
          />
          <select
            className={inputCls}
            aria-label="Linked study"
            value={confForm.linked_study_id}
            onChange={(e) => setConfForm({ ...confForm, linked_study_id: e.target.value })}
          >
            <option value="">No linked study</option>
            {studies.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
          <input
            className={inputCls}
            placeholder="Travel — e.g. Flights booked · hotel pending"
            aria-label="Travel"
            value={confForm.travel}
            onChange={(e) => setConfForm({ ...confForm, travel: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Next step — e.g. Poster print by Apr 10"
            aria-label="Next step"
            value={confForm.next_step}
            onChange={(e) => setConfForm({ ...confForm, next_step: e.target.value })}
          />
        </div>
      </Modal>
    </>
  );
}
