"use client";

import { useTheme } from "@/components/theme/ThemeProvider";
import { ACCENT_PRESETS, type AccentPreset, type BodyFace, type Companion, type Density, type DisplayFace, type NotifFeatures, type NotifType, type Presence, type SurfaceTone } from "@/lib/theme/interface-settings";
import { Seg } from "@/components/ui/Seg";
import type { ThemeMode } from "@/lib/types";

const DENSITY_OPTIONS: { value: Density; label: string; rows: number[]; gap: number; pad: number }[] = [
  { value: "cozy",    label: "Cozy",    rows: [1, 0.65, 0.45], gap: 10, pad: 14 },
  { value: "default", label: "Default", rows: [1, 0.65, 0.45], gap: 7,  pad: 10 },
  { value: "compact", label: "Compact", rows: [1, 0.65, 0.45], gap: 4,  pad: 7  },
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

export function InterfaceStudioDrawer() {
  const { theme, setTheme, interfaceSettings, setInterfaceSettings, interfaceStudioOpen, closeInterfaceStudio } = useTheme();
  if (!interfaceStudioOpen) return null;

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

  return (
    <>
      <div className="overlay-backdrop on" onClick={closeInterfaceStudio} aria-hidden />
      <div className="drawer on" role="dialog" aria-label="Interface Studio">
        <div className="dr-head">
          <div className="dr-title">Interface Studio</div>
          <button type="button" className="x" onClick={closeInterfaceStudio} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="dr-body">
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
          <Seg<SurfaceTone>
            options={[
              { label: "Deep", value: "deep" },
              { label: "Mid", value: "mid" },
              { label: "Lifted", value: "lifted" },
            ]}
            value={interfaceSettings.surfaceTone}
            onChange={(surfaceTone) => setInterfaceSettings((s) => ({ ...s, surfaceTone }))}
          />

          <div className="dr-sec">Corner Radius</div>
          <input
            type="range"
            min={0}
            max={16}
            value={interfaceSettings.cornerRadius}
            className="dr-range"
            onChange={(e) => setInterfaceSettings((s) => ({ ...s, cornerRadius: Number(e.target.value) }))}
          />

          <div className="dr-sec">Display Face</div>
          <Seg<DisplayFace>
            options={[
              { label: "Instrument", value: "instrument" },
              { label: "Playfair", value: "playfair" },
              { label: "Grotesk", value: "grotesk" },
            ]}
            value={interfaceSettings.displayFace}
            onChange={(displayFace) => setInterfaceSettings((s) => ({ ...s, displayFace }))}
          />

          <div className="dr-sec">Body Face</div>
          <Seg<BodyFace>
            options={[
              { label: "Archivo", value: "archivo" },
              { label: "Inter", value: "inter" },
              { label: "Plex", value: "plex" },
            ]}
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
          <div className="dr-note" style={{ marginTop: 8 }}>Banner notifications require browser permission. Silent mode logs to Dispatch without an OS alert.</div>

          <div className="dr-note">Theme editing lives here only — not in the sidebar. Changes apply instantly via CSS variables.</div>
        </div>
      </div>
    </>
  );
}
