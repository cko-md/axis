"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, Pencil, Plus, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Seg } from "@/components/ui/Seg";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import {
  INVESTMENT_HORIZONS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  RISK_POSTURES,
  confidencePercent,
  financialProfileSchema,
  isExpired,
  memoryCreateSchema,
  type FinancialProfileInput,
  type MemoryCreateInput,
} from "@/lib/memory/contracts";
import { useMemoryCenter, type MemoryItem } from "@/lib/hooks/useMemoryCenter";
import styles from "./MemoryCenter.module.css";

type Filter = "active" | "archived";

const DEFAULT_PROFILE: FinancialProfileInput = {
  base_currency: "USD",
  risk_posture: "balanced",
  investment_horizon: "long_term",
  liquidity_buffer_months: 6,
  concentration_limit_bps: 2000,
  priorities: [],
  constraints: [],
};

const EMPTY_MEMORY: MemoryCreateInput = {
  kind: "context",
  scope: "global",
  content: "",
  confidence_bps: 10000,
  expires_at: null,
};

const titleCase = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const lines = (value: string) => value.split("\n").map((entry) => entry.trim()).filter(Boolean);
const toDateTimeLocal = (value: string | null) => value ? new Date(value).toISOString().slice(0, 16) : "";

export function MemoryCenterModule() {
  const [filter, setFilter] = useState<Filter>("active");
  const center = useMemoryCenter(filter);
  const { toast } = useToast();
  const [profileDraft, setProfileDraft] = useState(DEFAULT_PROFILE);
  const [prioritiesText, setPrioritiesText] = useState("");
  const [constraintsText, setConstraintsText] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState(EMPTY_MEMORY);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<MemoryItem | null>(null);

  useEffect(() => {
    if (center.profile) {
      const { base_currency, risk_posture, investment_horizon, liquidity_buffer_months, concentration_limit_bps, priorities, constraints } = center.profile;
      setProfileDraft({ base_currency, risk_posture, investment_horizon, liquidity_buffer_months, concentration_limit_bps, priorities, constraints });
      setPrioritiesText(priorities.join("\n"));
      setConstraintsText(constraints.join("\n"));
    }
  }, [center.profile]);

  const profileConfirmed = useMemo(() => center.profile?.confirmed_at
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(center.profile.confirmed_at))
    : null, [center.profile]);

  const openCreate = () => {
    setEditing(null);
    setMemoryDraft(EMPTY_MEMORY);
    setMemoryOpen(true);
  };

  const openEdit = (item: MemoryItem) => {
    setEditing(item);
    setMemoryDraft({
      kind: item.kind,
      scope: item.scope,
      content: item.content,
      confidence_bps: item.confidence_bps,
      expires_at: item.expires_at,
    });
    setMemoryOpen(true);
  };

  const submitMemory = async () => {
    const parsed = memoryCreateSchema.safeParse(memoryDraft);
    if (!parsed.success) {
      toast("Complete the memory fields and keep the content within 1,200 characters.", "error", "Memory");
      return;
    }
    setMemoryBusy(true);
    const result = editing
      ? await center.updateMemory(editing.id, parsed.data)
      : await center.createMemory(parsed.data);
    setMemoryBusy(false);
    if (!result.ok) {
      toast("Could not save this memory.", "error", "Memory");
      return;
    }
    setMemoryOpen(false);
    toast(editing ? "Memory updated." : "Memory added.", "success", "Memory");
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setMemoryBusy(true);
    const result = await center.archiveMemory(archiveTarget.id);
    setMemoryBusy(false);
    if (!result.ok) {
      toast("Could not archive this memory.", "error", "Memory");
      return;
    }
    setArchiveTarget(null);
    toast("Memory archived.", "success", "Memory");
  };

  const restore = async (item: MemoryItem) => {
    setMemoryBusy(true);
    const result = await center.updateMemory(item.id, { status: "active" });
    setMemoryBusy(false);
    toast(result.ok ? "Memory restored." : "Could not restore this memory.", result.ok ? "success" : "error", "Memory");
  };

  const submitProfile = async () => {
    const parsed = financialProfileSchema.safeParse({
      ...profileDraft,
      priorities: lines(prioritiesText),
      constraints: lines(constraintsText),
    });
    if (!parsed.success) {
      toast("Review the profile limits and list lengths.", "error", "Financial profile");
      return;
    }
    setProfileBusy(true);
    const result = await center.saveProfile(parsed.data);
    setProfileBusy(false);
    toast(result.ok ? "Financial operating profile confirmed." : "Could not save the profile.", result.ok ? "success" : "error", "Financial profile");
  };

  if (center.loading) return <SkeletonCard rows={8} />;
  if (center.error === "SIGNED_OUT") {
    return <StatusCallout kind="setup_required" title="Sign in to manage memory">Your memory and financial profile are private to your account.</StatusCallout>;
  }
  if (center.error) {
    return <StatusCallout kind="error" title="Couldn’t load Memory Center"><Button onClick={() => void center.reload()}>Retry</Button></StatusCallout>;
  }

  return (
    <div className={styles.workspace}>
      <section aria-labelledby="financial-profile-heading">
        <div className={styles.sectionHeading}>
          <div>
            <div className="seclabel">Financial Operating Profile</div>
            <h2 id="financial-profile-heading" className={styles.heading}>Your explicit planning constraints</h2>
          </div>
          <div className={styles.confirmed}>{profileConfirmed ? `Confirmed ${profileConfirmed}` : "Not yet confirmed"}</div>
        </div>
        <Card className={styles.profileTool}>
          <div className={styles.formGrid}>
            <label>Base currency<input value={profileDraft.base_currency} maxLength={3} onChange={(event) => setProfileDraft((draft) => ({ ...draft, base_currency: event.target.value.toUpperCase() }))} /></label>
            <label>Risk posture<select value={profileDraft.risk_posture} onChange={(event) => setProfileDraft((draft) => ({ ...draft, risk_posture: event.target.value as FinancialProfileInput["risk_posture"] }))}>{RISK_POSTURES.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
            <label>Investment horizon<select value={profileDraft.investment_horizon} onChange={(event) => setProfileDraft((draft) => ({ ...draft, investment_horizon: event.target.value as FinancialProfileInput["investment_horizon"] }))}>{INVESTMENT_HORIZONS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
            <label>Liquidity buffer (months)<input type="number" min={0} max={120} value={profileDraft.liquidity_buffer_months} onChange={(event) => setProfileDraft((draft) => ({ ...draft, liquidity_buffer_months: Number(event.target.value) }))} /></label>
            <label>Position concentration limit (%)<input type="number" min={1} max={100} step={0.25} value={profileDraft.concentration_limit_bps / 100} onChange={(event) => setProfileDraft((draft) => ({ ...draft, concentration_limit_bps: Math.round(Number(event.target.value) * 100) }))} /></label>
            <label className={styles.wide}>Priorities, one per line<textarea rows={3} value={prioritiesText} onChange={(event) => setPrioritiesText(event.target.value)} /></label>
            <label className={styles.wide}>Constraints, one per line<textarea rows={3} value={constraintsText} onChange={(event) => setConstraintsText(event.target.value)} /></label>
          </div>
          <div className={styles.toolFooter}>
            <p>This profile guides drafts and simulations. It never authorizes communication, orders, or execution.</p>
            <Button variant="primary" loading={profileBusy} onClick={() => void submitProfile()}><Save size={14} />Confirm profile</Button>
          </div>
        </Card>
      </section>

      <section aria-labelledby="memory-list-heading">
        <div className={styles.sectionHeading}>
          <div>
            <div className="seclabel">Memory Center</div>
            <h2 id="memory-list-heading" className={styles.heading}>Inspectable context</h2>
          </div>
          <div className={styles.actions}><Seg options={[{ label: "Active", value: "active" }, { label: "Archived", value: "archived" }]} value={filter} onChange={setFilter} /><Button variant="primary" onClick={openCreate}><Plus size={14} />Add memory</Button></div>
        </div>
        {center.items.length === 0 ? (
          <StatusCallout kind="empty" title={filter === "active" ? "No active memories" : "No archived memories"}>{filter === "active" ? "Add only context you want Axis to retain and inspect later." : "Archived memories remain inspectable here."}</StatusCallout>
        ) : (
          <div className={styles.memoryGrid}>
            {center.items.map((item) => {
              const expired = isExpired(item.expires_at);
              return <Card key={item.id} className={styles.memoryCard}>
                <div className={styles.memoryMeta}><span>{titleCase(item.kind)}</span><span>{titleCase(item.scope)}</span><span data-expired={expired || undefined}>{expired ? "Expired" : confidencePercent(item.confidence_bps)}</span></div>
                <p className={styles.memoryContent}>{item.content}</p>
                <div className={styles.provenance}>Source: {titleCase(item.source_type)} · Updated {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.updated_at))}{item.expires_at ? ` · Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.expires_at))}` : ""}</div>
                <div className={styles.cardActions}>{item.status === "active" ? <><Button variant="ghost" onClick={() => openEdit(item)} aria-label="Edit memory"><Pencil size={14} /></Button><Button variant="ghost" onClick={() => setArchiveTarget(item)} aria-label="Archive memory"><Archive size={14} /></Button></> : <Button variant="secondary" disabled={memoryBusy} onClick={() => void restore(item)}><RotateCcw size={14} />Restore</Button>}</div>
              </Card>;
            })}
          </div>
        )}
      </section>

      <Modal open={memoryOpen} onClose={() => !memoryBusy && setMemoryOpen(false)} title={editing ? "Edit memory" : "Add memory"} footer={<><Button onClick={() => setMemoryOpen(false)} disabled={memoryBusy}>Cancel</Button><Button variant="primary" loading={memoryBusy} onClick={() => void submitMemory()}>{editing ? "Save changes" : "Add memory"}</Button></>}>
        <div className={styles.modalForm}>
          <label>Kind<select value={memoryDraft.kind} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, kind: event.target.value as MemoryCreateInput["kind"] }))}>{MEMORY_KINDS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
          <label>Scope<select value={memoryDraft.scope} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, scope: event.target.value as MemoryCreateInput["scope"] }))}>{MEMORY_SCOPES.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label>
          <label>Context<textarea autoFocus rows={5} maxLength={1200} value={memoryDraft.content} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, content: event.target.value }))} /></label>
          <label>Confidence (%)<input type="number" min={0} max={100} value={memoryDraft.confidence_bps / 100} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, confidence_bps: Math.round(Number(event.target.value) * 100) }))} /></label>
          <label>Expiry (optional)<input type="datetime-local" value={toDateTimeLocal(memoryDraft.expires_at)} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, expires_at: event.target.value ? new Date(event.target.value).toISOString() : null }))} /></label>
        </div>
      </Modal>

      <Modal open={Boolean(archiveTarget)} onClose={() => !memoryBusy && setArchiveTarget(null)} title="Archive memory" footer={<><Button onClick={() => setArchiveTarget(null)} disabled={memoryBusy}>Cancel</Button><Button variant="danger" loading={memoryBusy} onClick={() => void confirmArchive()}>Archive</Button></>}><p className={styles.confirmText}>Archive this memory? It will stop appearing as active context and can be restored later.</p></Modal>
    </div>
  );
}
