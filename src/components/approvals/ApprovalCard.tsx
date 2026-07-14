"use client";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { relativeTimeShort } from "@/lib/fund/freshnessBadge";
import {
  actionClassLabel,
  actionClassTone,
  approvalStatusLabel,
  approvalToneColor,
  formatApprovalAmount,
} from "@/lib/security/approvalCardView";
import type { ApprovalRecord, ApprovalDecision } from "@/lib/hooks/useApprovals";

/**
 * The approval card (§11.3): NEVER a bare "Allow". It always shows the exact
 * action, tool, target, amount, before/after state, data freshness, the reasons
 * approval is required, scope, and expiry — then offers the decision controls.
 * Step-up classes gate Approve behind an explicit step-up confirmation.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "3px 0" }}>
      <span style={{ color: "var(--ink-faint)", minWidth: 108 }}>{label}</span>
      <span style={{ color: "var(--ink)", flex: 1, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

export function ApprovalCard({
  approval,
  busy,
  onDecide,
  onStepUp,
}: {
  approval: ApprovalRecord;
  busy?: boolean;
  onDecide: (action: ApprovalDecision) => void;
  onStepUp: () => void;
}) {
  const pa = approval.proposed_action ?? ({} as ApprovalRecord["proposed_action"]);
  const tone = actionClassTone(approval.action_class);
  const toneColor = approvalToneColor(tone);
  const amount = formatApprovalAmount(pa.amount);
  const stepUpRequired = approval.requirement === "approval_step_up";
  const stepUpVerified = !!approval.step_up_verified_at;

  const isPending = approval.status === "pending";
  const isApproved = approval.status === "approved";

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".03em",
            color: toneColor,
            textTransform: "uppercase",
          }}
        >
          {actionClassLabel(approval.action_class)}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
          {approvalStatusLabel(approval.status)}
          {approval.scope === "persistent" ? " · standing" : ""}
        </span>
      </div>

      <p style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)", margin: "6px 0 10px" }}>
        {pa.summary ?? "(no summary provided)"}
      </p>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
        <Row label="Tool">{pa.tool ?? "—"}</Row>
        <Row label="Target">
          {pa.target?.entityType ?? "—"}
          {pa.target?.entityId ? ` · ${pa.target.entityId}` : ""}
          {pa.target?.accountId ? ` · acct ${pa.target.accountId}` : ""}
        </Row>
        {amount && <Row label="Amount">{amount}</Row>}
        {pa.dataFreshness && (
          <Row label="Data as of">
            <FreshnessBadge tier={pa.dataFreshness.tier} retrievedAt={pa.dataFreshness.retrievedAt} />
          </Row>
        )}
        {pa.beforeState !== undefined && (
          <Row label="Before">
            <code style={{ fontSize: 11 }}>{JSON.stringify(pa.beforeState)}</code>
          </Row>
        )}
        {pa.afterState !== undefined && (
          <Row label="After">
            <code style={{ fontSize: 11 }}>{JSON.stringify(pa.afterState)}</code>
          </Row>
        )}
        <Row label="Requested by">
          {pa.actor?.kind ?? "—"}
          {pa.actor?.id ? ` · ${pa.actor.id}` : ""}
          {pa.actor?.routineVersion != null ? ` (v${pa.actor.routineVersion})` : ""}
        </Row>
        {approval.expires_at && (
          <Row label="Expires">{relativeTimeShort(approval.expires_at) ?? approval.expires_at}</Row>
        )}
      </div>

      {approval.reasons.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--ink-dim)" }}>
          {approval.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {stepUpRequired && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          {stepUpVerified ? (
            <span style={{ color: "var(--up)", fontWeight: 600 }}>✓ Identity verified with passkey</span>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Button variant="secondary" onClick={onStepUp} disabled={busy}>
                Verify with passkey
              </Button>
              <span style={{ color: "var(--ink-dim)" }}>
                Required for {actionClassLabel(approval.action_class).toLowerCase()}.
              </span>
            </div>
          )}
        </div>
      )}

      {(isPending || isApproved) && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {isPending && (
            <>
              <Button variant="danger" onClick={() => onDecide("deny")} disabled={busy}>
                Deny
              </Button>
              <Button
                variant="primary"
                onClick={() => onDecide("approve")}
                disabled={busy || (stepUpRequired && !stepUpVerified)}
              >
                Approve
              </Button>
            </>
          )}
          {isApproved && (
            <Button variant="primary" onClick={() => onDecide("execute")} disabled={busy}>
              Clear to execute
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
