"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ACCENT_PRESETS, DEFAULT_INTERFACE_SETTINGS, type AccentPreset, type BodyFace, type Companion, type Density, type DisplayFace, type NotifFeatures, type NotifType, type Presence, type SurfaceTone } from "@/lib/theme/interface-settings";
import { Seg } from "@/components/ui/Seg";
import type { ThemeMode } from "@/lib/types";

const DENSITY_OPTIONS: { value: Density; label: string; rows: number[]; gap: number; pad: number }[] = [
  { value: "cozy",    label: "Cozy",    rows: [1, 0.65, 0.45], gap: 10, pad: 14 },
  { value: "default", label: "Default", rows: [1, 0.65, 0.45], gap: 7,  pad: 10 },
  { value: "compact", label: "Compact", rows: [1, 0.65, 0.45], gap: 4,  pad: 7  },
];

const DISPLAY_FACE_OPTIONS: { value: DisplayFace; label: string; sample: string; note: string; style: string }[] = [
  {
    value: "instrument",
    label: "Instrument",
    sample: "AXIS",
    note: "Architectural default",
    style: 'var(--font-serif), "Fraunces", Georgia, serif',
  },
  {
    value: "playfair",
    label: "Editorial",
    sample: "Signal",
    note: "Reading-forward serif",
    style: 'var(--font-playfair), "Playfair Display", Georgia, serif',
  },
  {
    value: "grotesk",
    label: "Grotesk",
    sample: "Command",
    note: "Technical display",
    style: 'var(--font-grotesk), "Space Grotesk", var(--font-narrow), sans-serif',
  },
];

const BODY_FACE_OPTIONS: { value: BodyFace; label: string; sample: string; note: string; style: string }[] = [
  {
    value: "archivo",
    label: "Archivo",
    sample: "A precise dashboard body for dense daily scanning.",
    note: "Default system voice",
    style: 'var(--font-sans), "Archivo", -apple-system, sans-serif',
  },
  {
    value: "inter",
    label: "Inter",
    sample: "A neutral body face tuned for product interfaces.",
    note: "Modern utility",
    style: 'var(--font-inter), "Inter", -apple-system, sans-serif',
  },
  {
    value: "plex",
    label: "Plex",
    sample: "A slightly engineered rhythm for notes and data.",
    note: "Analytical tone",
    style: 'var(--font-plex), "IBM Plex Sans", -apple-system, sans-serif',
  },
];

const SURFACE_TONE_OPTIONS: { value: SurfaceTone; label: string; note: string }[] = [
  { value: "deep", label: "Deep", note: "Receded panels" },
  { value: "mid", label: "Mid", note: "Balanced default" },
  { value: "lifted", label: "Lifted", note: "Brighter slabs" },
];

function DensityPicker({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <div style={{ display: "flex", gap: 7 }}>
      {DENSITY_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              background: active ? "rgba(201,164,99,.08)" : "var(--glass)",
              border: `1px solid ${active ? "var(--gold)" : "var(--line)"}`,
              borderRadius: "var(--rl)",
              padding: `${opt.pad}px 10px 8px`,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: opt.gap,
              transition: "border-color 0.14s, background 0.14s",
            }}
          >
            {opt.rows.map((w, i) => (
              <div
                key={i}
                style={{
                  height: 3,
                  borderRadius: 2,
                  background: active ? "var(--gold)" : "var(--line-strong)",
                  opacity: w,
                  width: `${Math.round(w * 100)}%`,
                  transition: "background 0.14s, opacity 0.14s",
                }}
              />
            ))}
            <span style={{
              fontSize: 9,
              fontFamily: "var(--narrow)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: active ? "var(--gold)" : "var(--ink-faint)",
              marginTop: 6,
              textAlign: "center",
              transition: "color 0.14s",
            }}>
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SurfaceTonePicker({ value, onChange }: { value: SurfaceTone; onChange: (tone: SurfaceTone) => void }) {
  return (
    <div className="tone-cards">
      {SURFACE_TONE_OPTIONS.map((tone) => {
        const active = value === tone.value;
        return (
          <button
            key={tone.value}
            type="button"
            className={active ? `tone-card tone-${tone.value} on` : `tone-card tone-${tone.value}`}
            onClick={() => onChange(tone.value)}
            aria-pressed={active}
          >
            <span className="tone-stack" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <b>{tone.label}</b>
            <small>{tone.note}</small>
          </button>
        );
      })}
    </div>
  );
}

function RadiusPreview({ value }: { value: number }) {
  const radius = `${value}px`;
  const largeRadius = `${Math.max(value + 4, 4)}px`;
  return (
    <div className="radius-preview" style={{ borderRadius: largeRadius }}>
      <div className="radius-preview-card" style={{ borderRadius: largeRadius }}>
        <span style={{ borderRadius: radius }} />
        <div>
          <b>{value}px</b>
          <small>{Math.max(value + 4, 4)}px large</small>
        </div>
      </div>
      <div className="radius-preview-row" aria-hidden>
        <i style={{ borderRadius: radius }} />
        <i style={{ borderRadius: radius }} />
        <i style={{ borderRadius: radius }} />
      </div>
    </div>
  );
}

function FontFacePicker<T extends DisplayFace | BodyFace>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; sample: string; note: string; style: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="font-cards">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? "font-card on" : "font-card"}
            onClick={() => onChange(option.value)}
            aria-pressed={active}
          >
            <span className="font-card-k">{option.label}</span>
            <strong style={{ fontFamily: option.style }}>{option.sample}</strong>
            <small>{option.note}</small>
          </button>
        );
      })}
    </div>
  );
}

export function InterfaceStudioDrawer() {
  const { theme, setTheme, interfaceSettings, setInterfaceSettings, interfacePersistence, interfaceStudioOpen, closeInterfaceStudio } = useTheme();
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!interfaceStudioOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeInterfaceStudio();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [closeInterfaceStudio, interfaceStudioOpen]);

  if (!interfaceStudioOpen) return null;

  const resetToDefaults = () => {
    if (typeof window !== "undefined" && !window.confirm("Reset all interface settings to their defaults? Theme, accent, faces, density, and presence will revert.")) {
      return;
    }
    setInterfaceSettings(DEFAULT_INTERFACE_SETTINGS);
    setTheme("dark");
  };

  const modes: { label: string; value: ThemeMode }[] = [
    { label: "Dark", value: "dark" },
    { label: "Dim", value: "dim" },
    { label: "Slate", value: "slate" },
    { label: "Light", value: "light" },
  ];

  const accents = (Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((k) => ({
    key: k,
    ...ACCENT_PRESETS[k],
  }));
  const activeAccent = ACCENT_PRESETS[interfaceSettings.accent] ?? ACCENT_PRESETS.gold;
  const displayLabel = interfaceSettings.displayFace === "instrument" ? "Instrument" : interfaceSettings.displayFace === "playfair" ? "Editorial" : "Grotesk";
  const bodyLabel = interfaceSettings.bodyFace === "archivo" ? "Archivo" : interfaceSettings.bodyFace === "inter" ? "Inter" : "Plex";
  const presenceLabel = interfaceSettings.presence === "hide"
    ? "Hidden"
    : interfaceSettings.companion === "monolith"
      ? "Axiom"
      : interfaceSettings.companion === "deck"
        ? "Codex"
        : "Nova";
  const persistenceLabel = interfacePersistence === "synced"
    ? "Synced"
    : interfacePersistence === "syncing"
      ? "Syncing"
      : interfacePersistence === "error"
        ? "Sync error"
        : interfacePersistence === "loading"
          ? "Checking sync"
          : "Local only";

  return (
    <>
      <div className="overlay-backdrop on" onClick={closeInterfaceStudio} aria-hidden />
      <div className="drawer on" role="dialog" aria-modal="true" aria-label="Interface Studio" ref={drawerRef}>
        <div className="dr-head">
          <div>
            <div className="dr-title">Interface Studio</div>
            <div className={`dr-persist ${interfacePersistence}`}>{persistenceLabel}</div>
          </div>
          <button type="button" className="x" onClick={closeInterfaceStudio} aria-label="Close" ref={closeButtonRef}>
            ✕
          </button>
        </div>
        <div className="dr-body">
          <div className="dr-preview" aria-label="Interface preview">
            <div className="dr-preview-main">
              <span style={{ background: `linear-gradient(135deg, ${activeAccent.accent}, ${activeAccent.accent2})` }} />
              <div>
                <strong>{theme}</strong>
                <small>{activeAccent.label}</small>
              </div>
            </div>
            <div className="dr-preview-grid">
              <div>
                <b>Type</b>
                <small>{displayLabel} / {bodyLabel}</small>
              </div>
              <div>
                <b>Density</b>
                <small>{interfaceSettings.density}</small>
              </div>
              <div>
                <b>Presence</b>
                <small>{presenceLabel}</small>
              </div>
            </div>
          </div>

          <div className="dr-sec">Mode</div>
          <Seg options={modes} value={theme} onChange={setTheme} />

          <div className="dr-sec">Accent</div>
          <div className="swatches">
            {accents.map((a) => (
              <button
                key={a.key}
                type="button"
                title={a.label}
                className={interfaceSettings.accent === a.key ? "on" : ""}
                style={{ background: `linear-gradient(135deg, ${a.accent}, ${a.accent2})` }}
                onClick={() => setInterfaceSettings((s) => ({ ...s, accent: a.key }))}
              />
            ))}
          </div>

          <div className="dr-sec">Surface Tone</div>
          <SurfaceTonePicker
            value={interfaceSettings.surfaceTone}
            onChange={(surfaceTone) => setInterfaceSettings((s) => ({ ...s, surfaceTone }))}
          />

          <div className="dr-sec">Corner Radius</div>
          <RadiusPreview value={interfaceSettings.cornerRadius} />
          <input
            type="range"
            min={0}
            max={16}
            value={interfaceSettings.cornerRadius}
            className="dr-range"
            aria-label="Corner radius"
            onChange={(e) => setInterfaceSettings((s) => ({ ...s, cornerRadius: Number(e.target.value) }))}
          />

          <div className="dr-sec">Display Face</div>
          <FontFacePicker<DisplayFace>
            options={DISPLAY_FACE_OPTIONS}
            value={interfaceSettings.displayFace}
            onChange={(displayFace) => setInterfaceSettings((s) => ({ ...s, displayFace }))}
          />

          <div className="dr-sec">Body Face</div>
          <FontFacePicker<BodyFace>
            options={BODY_FACE_OPTIONS}
            value={interfaceSettings.bodyFace}
            onChange={(bodyFace) => setInterfaceSettings((s) => ({ ...s, bodyFace }))}
          />

          <div className="dr-sec">Density</div>
          <DensityPicker
            value={interfaceSettings.density}
            onChange={(density) => setInterfaceSettings((s) => ({ ...s, density }))}
          />

          <div className="dr-sec">Presence Form</div>
          <Seg<Companion>
            options={[
              { label: "Axiom", value: "monolith" },
              { label: "Codex", value: "deck" },
              { label: "Nova", value: "nova" },
            ]}
            value={interfaceSettings.companion}
            onChange={(companion) => setInterfaceSettings((s) => ({ ...s, companion, presence: "show" }))}
          />

          <div className="dr-sec">Presence Visibility</div>
          <Seg<Presence>
            options={[
              { label: "Show", value: "show" },
              { label: "Hide", value: "hide" },
            ]}
            value={interfaceSettings.presence}
            onChange={(presence) => setInterfaceSettings((s) => ({ ...s, presence }))}
          />

          <div className="dr-sec">Location Services</div>
          <Seg<"on" | "off">
            options={[
              { label: "On", value: "on" },
              { label: "Off", value: "off" },
            ]}
            value={interfaceSettings.locationServices ? "on" : "off"}
            onChange={(v) => setInterfaceSettings((s) => ({ ...s, locationServices: v === "on" }))}
          />
          <div className="dr-note" style={{ marginTop: 4 }}>Enables accurate local weather, air quality, and daylight from your device GPS. Browser permission required.</div>

          <div className="dr-sec">Notifications</div>
          <Seg<"on" | "off">
            options={[
              { label: "On", value: "on" },
              { label: "Off", value: "off" },
            ]}
            value={interfaceSettings.notifEnabled ? "on" : "off"}
            onChange={async (v) => {
              if (v === "on" && typeof window !== "undefined" && "Notification" in window) {
                const perm = await Notification.requestPermission();
                if (perm !== "granted") return;
              }
              setInterfaceSettings((s) => ({ ...s, notifEnabled: v === "on" }));
            }}
          />
          {interfaceSettings.notifEnabled && (
            <>
              <div className="dr-sec" style={{ marginTop: 8 }}>Notification Style</div>
              <Seg<NotifType>
                options={[
                  { label: "Banner", value: "banner" },
                  { label: "Silent", value: "silent" },
                  { label: "None", value: "none" },
                ]}
                value={interfaceSettings.notifType}
                onChange={(notifType) => setInterfaceSettings((s) => ({ ...s, notifType }))}
              />
              <div className="dr-sec" style={{ marginTop: 8 }}>Feature Alerts</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {(Object.keys(interfaceSettings.notifFeatures) as (keyof NotifFeatures)[]).map((feat) => {
                  const on = interfaceSettings.notifFeatures[feat];
                  const labels: Record<keyof NotifFeatures, string> = {
                    pomodoro: "Pomodoro", agenda: "Agenda", mail: "Mail",
                    contacts: "Contacts", literature: "Literature", markets: "Markets", dispatch: "Dispatch",
                  };
                  return (
                    <button
                      key={feat}
                      type="button"
                      onClick={() => setInterfaceSettings((s) => ({
                        ...s,
                        notifFeatures: { ...s.notifFeatures, [feat]: !s.notifFeatures[feat] },
                      }))}
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        padding: "7px 10px",
                        background: on ? "rgba(201,164,99,.08)" : "var(--glass)",
                        border: `1px solid ${on ? "var(--gold)" : "var(--line)"}`,
                        borderRadius: "var(--r)",
                        cursor: "pointer",
                        fontSize: 11,
                        color: on ? "var(--gold)" : "var(--ink-dim)",
                        fontFamily: "var(--narrow)",
                        letterSpacing: "0.05em",
                        transition: "border-color 0.14s, background 0.14s, color 0.14s",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? "var(--gold)" : "var(--line-strong)", flexShrink: 0 }} />
                      {labels[feat]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className="dr-note" style={{ marginTop: 8 }}>
            Preferences are saved for signed-in accounts. OS notification delivery is not wired yet — toggles record intent only until the notification service ships.
          </div>

          <div className="dr-sec">Reset</div>
          <button
            type="button"
            onClick={resetToDefaults}
            style={{
              width: "100%",
              background: "var(--glass)",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--rl)",
              padding: "10px 12px",
              cursor: "pointer",
              fontFamily: "var(--narrow)",
              fontWeight: 600,
              fontSize: 10,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "var(--ink-dim)",
              transition: "border-color .14s, color .14s, background .14s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--clay-2)"; e.currentTarget.style.color = "var(--clay-2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.color = "var(--ink-dim)"; }}
          >
            Reset to defaults
          </button>
          <div className="dr-note" style={{ marginTop: 8 }}>Reverts theme, accent, faces, density, and presence to the Atelier defaults. Confirmation required.</div>

          <div className="dr-note">Theme editing lives here only — not in the sidebar. Changes apply instantly via CSS variables.</div>
        </div>
      </div>
    </>
  );
}
