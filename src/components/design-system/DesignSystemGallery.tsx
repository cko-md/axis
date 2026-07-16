"use client";

import { useEffect, useRef, useState } from "react";
import type { ThemeMode } from "@/lib/types";
import { useTheme } from "@/components/theme/ThemeProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { Modal } from "@/components/ui/Modal";
import { Seg } from "@/components/ui/Seg";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { AxisGlassPanel } from "@/components/ui/axis/AxisGlassPanel";
import { cssToken, MOTION_TOKENS, SURFACE_TOKENS, TYPOGRAPHY_TOKENS } from "@/lib/design/systemTokens";
import styles from "./DesignSystemGallery.module.css";

const THEMES: { label: string; value: ThemeMode }[] = [
  { label: "Dark", value: "dark" },
  { label: "Dim", value: "dim" },
  { label: "Slate", value: "slate" },
  { label: "Light", value: "light" },
];

const SURFACES = [
  ["Canvas", SURFACE_TOKENS.canvas],
  ["Chrome", SURFACE_TOKENS.chrome],
  ["Panel", SURFACE_TOKENS.panel],
  ["Raised", SURFACE_TOKENS.raised],
  ["Input", SURFACE_TOKENS.input],
  ["Overlay", SURFACE_TOKENS.overlay],
] as const;

const MOTION_ROLES = [
  ["Instant", MOTION_TOKENS.instant],
  ["Fast", MOTION_TOKENS.fast],
  ["Base", MOTION_TOKENS.base],
  ["Deliberate", MOTION_TOKENS.deliberate],
  ["Ambient", MOTION_TOKENS.ambient],
  ["Standard easing", MOTION_TOKENS.standardEase],
  ["Enter easing", MOTION_TOKENS.enterEase],
  ["Exit easing", MOTION_TOKENS.exitEase],
] as const;

export function DesignSystemGallery() {
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const [density, setDensity] = useState<"standard" | "compact">("standard");
  const [modalKind, setModalKind] = useState<"review" | "destructive" | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (loadingTimer.current !== null) window.clearTimeout(loadingTimer.current);
  }, []);

  const showLoading = () => {
    if (loadingTimer.current !== null) window.clearTimeout(loadingTimer.current);
    setLoading(true);
    loadingTimer.current = window.setTimeout(() => {
      setLoading(false);
      loadingTimer.current = null;
      toast("The loading-state contract completed.", "success", "Design system");
    }, 900);
  };

  const confirmDestructiveDemo = () => {
    setModalKind(null);
    toast("Confirmation captured. The reference gallery never mutates user data.", "info", "Destructive pattern");
  };

  return (
    <div className={styles.gallery} data-density-preview={density}>
      <header className={styles.header}>
        <div>
          <div className="eyebrow">System reference</div>
          <h1 className={styles.title}>AXIS Design System</h1>
          <p className={styles.lede}>Operational typography, surfaces, states, and controls.</p>
        </div>
        <div className={styles.headerControls}>
          <Seg options={THEMES} value={theme} onChange={setTheme} ariaLabel="Color theme" />
          <Seg
            options={[{ label: "Standard", value: "standard" }, { label: "Compact", value: "compact" }]}
            value={density}
            onChange={setDensity}
            ariaLabel="Gallery density"
          />
        </div>
      </header>

      <section className={styles.band} aria-labelledby="gallery-type">
        <div className={styles.bandHeading}>
          <h2 id="gallery-type">Typography</h2>
          <code>{TYPOGRAPHY_TOKENS.displayFamily}</code>
        </div>
        <div className={styles.typeSpecimens}>
          <p className={styles.specimenLabel}>Typography specimens — illustrative content</p>
          <p className={styles.displaySpecimen}>DECISIONS, IN FOCUS</p>
          <p className={styles.titleSpecimen}>One operating surface for the day ahead</p>
          <p className={styles.headingSpecimen}>Operational heading / deterministic review</p>
          <p className={styles.bodySpecimen}>Context stays legible, provenance stays visible, and important actions remain deliberate.</p>
          <p className={styles.smallSpecimen}>Supporting context remains readable at the shared small-text role.</p>
          <p className={styles.labelSpecimen}>SEMANTIC LABEL / OWNER-SCOPED</p>
          <p className={styles.codeSpecimen}>EXAMPLE RUN / FRESH / OWNER-SCOPED / 09:42</p>
        </div>
      </section>

      <section className={styles.band} aria-labelledby="gallery-surfaces">
        <div className={styles.bandHeading}>
          <h2 id="gallery-surfaces">Surfaces</h2>
          <code>{SURFACE_TOKENS.panel}</code>
        </div>
        <div className={styles.surfaceGrid}>
          {SURFACES.map(([label, token]) => (
            <div key={token} className={styles.surfaceSample} style={{ background: `var(${token})` }}>
              <strong>{label}</strong>
              <code>{token}</code>
            </div>
          ))}
          <AxisGlassPanel className={styles.surfaceSample}>
            <strong>Glass panel</strong>
            <code>AxisGlassPanel</code>
          </AxisGlassPanel>
          <AxisChromePanel className={styles.surfaceSample}>
            <strong>Chrome panel</strong>
            <code>AxisChromePanel</code>
          </AxisChromePanel>
          <div
            className={styles.surfaceSample}
            style={{ borderColor: cssToken(SURFACE_TOKENS.borderStrong), boxShadow: cssToken(SURFACE_TOKENS.shadowPanel) }}
          >
            <strong>Strong boundary</strong>
            <code>{SURFACE_TOKENS.borderStrong} / {SURFACE_TOKENS.shadowPanel}</code>
          </div>
        </div>
      </section>

      <section className={styles.band} aria-labelledby="gallery-controls">
        <div className={styles.bandHeading}>
          <h2 id="gallery-controls">Controls</h2>
          <code>{MOTION_TOKENS.fast}</code>
        </div>
        <div className={styles.controlRow}>
          <Button variant="primary" loading={loading} onClick={showLoading}>Run check</Button>
          <Button variant="secondary" onClick={() => setModalKind("review")}>Open dialog</Button>
          <Button variant="ghost" onClick={() => toast("Quiet action completed.", "info", "Design system")}>Quiet action</Button>
          <Button variant="danger" onClick={() => setModalKind("destructive")}>Destructive</Button>
        </div>
        <div className={styles.loadingRow} role="status" aria-label="Loading placeholders">
          <span className="sr-only">Example loading placeholders</span>
          <Skeleton width="34%" height={12} />
          <Skeleton width="68%" height={12} />
          <Skeleton width="52%" height={12} />
        </div>
        <div className={styles.motionGrid} aria-label="Semantic motion roles">
          {MOTION_ROLES.map(([label, token]) => (
            <div key={token} className={styles.motionRole}>
              <span>{label}</span>
              <code>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.band} aria-labelledby="gallery-states">
        <div className={styles.bandHeading}>
          <h2 id="gallery-states">System states</h2>
          <FreshnessBadge tier="fresh" showRelative={false} />
        </div>
        <div className={styles.stateGrid}>
          <StatusCallout kind="success" title="Example: Routine completed">Illustrative success state with deterministic steps recorded.</StatusCallout>
          <StatusCallout kind="stale" title="Example: Provider delayed">Illustrative stale state showing the last confirmed snapshot.</StatusCallout>
          <StatusCallout kind="error" title="Example: Action blocked">Illustrative error state with a visible retry precondition.</StatusCallout>
          <Card tick className={styles.referenceCard}>
            <div className="seclabel">Reference specimen</div>
            <strong>Inspectable by default</strong>
            <p>Source, state, and next action remain visible.</p>
          </Card>
        </div>
      </section>

      <Modal
        open={modalKind !== null}
        onClose={() => setModalKind(null)}
        title={modalKind === "destructive" ? "Confirm destructive action" : "Review dialog"}
        footer={modalKind === "destructive" ? (
          <>
            <Button variant="ghost" onClick={() => setModalKind(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDestructiveDemo}>Confirm</Button>
          </>
        ) : <Button onClick={() => setModalKind(null)}>Done</Button>}
      >
        <p className={styles.modalCopy}>
          {modalKind === "destructive"
            ? "Production destructive actions require an explicit confirmation step. This reference changes no user data."
            : "Focus enters the dialog, remains trapped while open, and returns to the trigger on close."}
        </p>
      </Modal>
    </div>
  );
}
