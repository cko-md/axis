"use client";

import { useTheme } from "@/components/theme/ThemeProvider";
import { ACCENT_PRESETS, type AccentPreset, type BodyFace, type Companion, type Density, type DisplayFace, type Presence, type SurfaceTone } from "@/lib/theme/interface-settings";
import { Seg } from "@/components/ui/Seg";
import type { ThemeMode } from "@/lib/types";

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
          <Seg<Density>
            options={[
              { label: "Cozy", value: "cozy" },
              { label: "Default", value: "default" },
              { label: "Compact", value: "compact" },
            ]}
            value={interfaceSettings.density}
            onChange={(density) => setInterfaceSettings((s) => ({ ...s, density }))}
          />

          <div className="dr-sec">Companion Form</div>
          <Seg<Companion>
            options={[
              { label: "Monolith", value: "monolith" },
              { label: "Deck", value: "deck" },
            ]}
            value={interfaceSettings.companion}
            onChange={(companion) => setInterfaceSettings((s) => ({ ...s, companion, presence: "show" }))}
          />

          <div className="dr-sec">Companion Presence</div>
          <Seg<Presence>
            options={[
              { label: "Show", value: "show" },
              { label: "Hide", value: "hide" },
            ]}
            value={interfaceSettings.presence}
            onChange={(presence) => setInterfaceSettings((s) => ({ ...s, presence }))}
          />

          <div className="dr-note">Theme editing lives here only — not in the sidebar. Changes apply instantly via CSS variables.</div>
        </div>
      </div>
    </>
  );
}
