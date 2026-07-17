"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatusCallout } from "@/components/ui/StatusCallout";
import type { VectorConflictResolution } from "@/lib/vector/contracts";
import type { VectorLocalConflict } from "@/lib/vector/persistence-types";
import styles from "./Vector.module.css";

type Resolution = VectorConflictResolution["resolution"];

type Props = {
  conflict: VectorLocalConflict | null;
  busy: boolean;
  error: string | null;
  motion?: "standard" | "reduced";
  migrationRetryAvailable?: boolean;
  onClose: () => void;
  onResolve: (resolution: Resolution, targetSlotId?: string) => Promise<void>;
  onRetryMigration?: () => Promise<void>;
};

function safeForkSlot(slotId: string) {
  const suffix = "-fork";
  return `${slotId.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

export function buildVectorConflictExport(
  conflict: VectorLocalConflict,
  exportedAt = new Date().toISOString(),
) {
  return {
    schemaVersion: 1,
    exportedAt,
    conflict: {
      id: conflict.id,
      authority: conflict.authority,
      gameId: conflict.gameId,
      slotId: conflict.slotId,
      reason: conflict.reason,
      conflictVersion: conflict.conflictVersion,
      status: conflict.status,
      resolution: conflict.resolution ?? null,
      expectedAncestorLocalRevision:
        conflict.expectedAncestorLocalRevision ?? null,
      expectedAncestorChecksum: conflict.expectedAncestorChecksum ?? null,
      currentLocalRevision: conflict.currentLocalRevision ?? null,
      currentIntegrityChecksum: conflict.currentIntegrityChecksum ?? null,
      currentSyncState: conflict.currentSyncState ?? null,
      currentLastErrorCode: conflict.currentLastErrorCode ?? null,
      local: conflict.local,
      server: conflict.server,
      createdAt: conflict.createdAt,
      resolvedAt: conflict.resolvedAt,
    },
  };
}

function downloadConflict(conflict: VectorLocalConflict) {
  const blob = new Blob([
    JSON.stringify(buildVectorConflictExport(conflict), null, 2),
  ], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vector-${conflict.gameId}-${conflict.slotId}-conflict.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function VectorConflictModal({
  conflict,
  busy,
  error,
  motion,
  migrationRetryAvailable = false,
  onClose,
  onResolve,
  onRetryMigration,
}: Props) {
  const [resolution, setResolution] = useState<Resolution>("accept-server");
  const [targetSlotId, setTargetSlotId] = useState("");

  useEffect(() => {
    setResolution("accept-server");
    setTargetSlotId(conflict ? safeForkSlot(conflict.slotId) : "");
  }, [conflict]);

  const localCorrupt = conflict?.reason === "local_checksum_mismatch";
  const localConcurrent = conflict?.reason === "local_concurrent_write";
  const localSchemaBlocked = Boolean(conflict && [
    "save_schema_newer",
    "save_migrator_missing",
    "save_migration_failed",
  ].includes(conflict.reason));
  const localBranchUsable = Boolean(
    conflict?.local.state !== undefined
    && !localCorrupt
    && !localSchemaBlocked,
  );
  const serverNeedsHydration = Boolean(
    conflict
    && !localConcurrent
    && conflict.authority === "local"
    && conflict.server.serverRevision > 0
    && conflict.server.state === undefined,
  );
  // Cloud authority resolves against server-side truth. A browser-only
  // conflict must carry the branch locally, except revision 0 (explicit delete).
  const serverBranchUsable = Boolean(conflict && !serverNeedsHydration);
  const choices = useMemo(() => {
    if (!conflict) return [];
    return [
      {
        value: "accept-server" as const,
        disabled: !serverBranchUsable,
        title: localConcurrent && conflict.currentLocalRevision === null
          ? "Keep the current deletion"
          : localConcurrent
            ? "Keep the current local branch"
            : conflict.server.serverRevision === 0
          ? "Remove the local slot"
          : "Keep the synchronized branch",
        detail: localConcurrent && conflict.currentLocalRevision === null
          ? "The slot was deleted after this runtime began. Keep that deletion and discard the attempted stale write."
          : localConcurrent
            ? `Keep current local revision ${conflict.currentLocalRevision} in the original slot.`
            : conflict.server.serverRevision === 0
          ? "The server has no accepted branch. This removes the local slot after preserving this exportable conflict record."
          : serverNeedsHydration
            ? `Server revision ${conflict.server.serverRevision} is known, but its payload must be restored by account reconciliation before it can replace this slot.`
            : `Keep server revision ${conflict.server.serverRevision} in the original slot.`,
      },
      {
        value: "accept-local" as const,
        disabled: !localBranchUsable,
        title: localConcurrent
          ? "Keep the attempted runtime branch"
          : "Keep the local branch",
        detail: localCorrupt
          ? "A checksum-invalid branch cannot be accepted as valid game state."
          : localSchemaBlocked
          ? "This branch remains preserved until a compatible explicit save migrator is available."
          : localConcurrent
            ? `Replace the current branch with preserved attempted revision ${conflict.local.localRevision}.`
            : `Queue local revision ${conflict.local.localRevision} against the accepted server revision.`,
      },
      {
        value: "fork-local" as const,
        disabled: !localBranchUsable || !serverBranchUsable,
        title: "Keep both in separate slots",
        detail: localConcurrent
          ? "Keep the current local branch here and copy the attempted runtime branch to a new pending slot."
          : "Keep the synchronized branch here and copy the local branch to a new pending slot.",
      },
    ];
  }, [
    conflict,
    localBranchUsable,
    localConcurrent,
    localCorrupt,
    localSchemaBlocked,
    serverBranchUsable,
    serverNeedsHydration,
  ]);

  if (!conflict) return null;
  const selected = choices.find((choice) => choice.value === resolution);
  const invalidTarget = resolution === "fork-local" && (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(targetSlotId) ||
    targetSlotId === conflict.slotId
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Resolve ${conflict.gameId} / ${conflict.slotId}`}
      motion={motion}
      busy={busy}
      footer={(
        <>
          {localSchemaBlocked ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy || !migrationRetryAvailable || !onRetryMigration}
              title={
                migrationRetryAvailable
                  ? "Run the installed game's explicit save migrators."
                  : "A compatible playable game update is required."
              }
              onClick={() => void onRetryMigration?.()}
            >
              Retry compatible migration
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => downloadConflict(conflict)}
          >
            Export both branches
          </Button>
          <Button type="button" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            variant={
              resolution === "accept-server" && (
                localConcurrent
                  ? conflict.currentLocalRevision === null
                  : conflict.server.serverRevision === 0
              )
                ? "danger"
                : "primary"
            }
            disabled={busy || selected?.disabled || invalidTarget}
            onClick={() => void onResolve(
              resolution,
              resolution === "fork-local" ? targetSlotId : undefined,
            )}
          >
            {busy ? "Resolving…" : "Confirm resolution"}
          </Button>
        </>
      )}
    >
      <div className={styles.conflictModalBody}>
        <p>
          VECTOR preserved both branches because it could not prove that one
          safely superseded the other. Choose explicitly; no last-write-wins
          overwrite is performed.
        </p>
        <dl className={styles.conflictReadout}>
          <div>
            <dt>Reason</dt>
            <dd>{conflict.reason.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Authority</dt>
            <dd>{conflict.authority === "cloud" ? "Synchronized account" : "This browser"}</dd>
          </div>
          <div>
            <dt>{localConcurrent ? "Attempted runtime" : "Local"}</dt>
            <dd>revision {conflict.local.localRevision}</dd>
          </div>
          <div>
            <dt>{localConcurrent ? "Current local" : "Server"}</dt>
            <dd>
              {localConcurrent
                ? conflict.currentLocalRevision === null
                  ? "deleted"
                  : `revision ${conflict.currentLocalRevision}`
                : conflict.server.serverRevision > 0
                ? `revision ${conflict.server.serverRevision}`
                : "no accepted branch"}
            </dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd>{new Date(conflict.createdAt).toLocaleString()}</dd>
          </div>
        </dl>

        {localCorrupt ? (
          <StatusCallout kind="error" title="The local branch failed checksum validation.">
            It remains exportable for recovery, but VECTOR will not hydrate,
            accept, or fork it as trusted game state.
          </StatusCallout>
        ) : null}
        {localSchemaBlocked ? (
          <StatusCallout kind="error" title="This save schema cannot be hydrated safely.">
            The original branch remains exportable and unchanged. Install a
            compatible game update before retrying, or explicitly export and
            remove the slot; VECTOR will not guess a migration.
          </StatusCallout>
        ) : null}
        {serverNeedsHydration ? (
          <StatusCallout kind="info" title="The synchronized branch payload is not loaded.">
            {conflict.ownerKey.startsWith("user:")
              ? "Reconnect or reload this signed-in profile to reconcile cloud state, then reopen the conflict. VECTOR will not pretend that revision metadata alone is a restorable save."
              : "This anonymous namespace has revision metadata but no restorable branch payload. Export the record for recovery; VECTOR will not accept metadata as game state."}
          </StatusCallout>
        ) : null}
        {error ? (
          <StatusCallout kind="error" title="The conflict remains unresolved.">
            {error}
          </StatusCallout>
        ) : null}

        <fieldset className={styles.conflictChoices} disabled={busy}>
          <legend>Resolution</legend>
          {choices.map((choice) => (
            <label key={choice.value} data-disabled={choice.disabled || undefined}>
              <input
                type="radio"
                name="vector-conflict-resolution"
                value={choice.value}
                checked={resolution === choice.value}
                disabled={choice.disabled}
                onChange={() => setResolution(choice.value)}
              />
              <span>
                <strong>{choice.title}</strong>
                <small>{choice.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {resolution === "fork-local" ? (
          <label className={styles.conflictSlotField}>
            <span>New slot ID</span>
            <input
              value={targetSlotId}
              maxLength={64}
              disabled={busy}
              aria-invalid={invalidTarget}
              onChange={(event) => setTargetSlotId(event.target.value)}
            />
            {invalidTarget ? (
              <small>Use a different 1–64 character letter/number slot ID.</small>
            ) : null}
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
