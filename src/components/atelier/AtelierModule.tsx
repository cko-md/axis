"use client";

import { useState } from "react";

type LangKey = "fr" | "es" | "yo";

const LANGS: { key: LangKey; flag: string; label: string; lv: string }[] = [
  { key: "fr", flag: "🇫🇷", label: "French", lv: "B2 → C1" },
  { key: "es", flag: "🇪🇸", label: "Spanish", lv: "Medical" },
  { key: "yo", flag: "🟢", label: "Yoruba", lv: "Foundation" },
];

const LANG_DATA: Record<
  LangKey,
  { name: string; lessons: [string, string, string][]; resources: [boolean, string, string][] }
> = {
  fr: {
    name: "French",
    lessons: [
      ["TUE", "Le Monde — skim one article", "8 min · input"],
      ["THU", "C1 connector drill", "5 min · Anki"],
      ["SAT", "InnerFrench — shadow 1 clip", "10 min · speaking"],
    ],
    resources: [
      [true, "InnerFrench — intermediate podcast", "AUDIO"],
      [true, "Le Monde — daily reading", "READ"],
      [false, "Kwiziq — adaptive C1 grammar", "DRILL"],
      [false, "Italki — conversation tutors", "SPEAK"],
    ],
  },
  es: {
    name: "Spanish",
    lessons: [
      ["MON", "Medical phrase of the day", "5 min · clinical"],
      ["WED", "Patient-instruction lines", "8 min · speaking"],
      ["SAT", "Symptom vocabulary set", "7 min · Anki"],
    ],
    resources: [
      [true, "Canopy — Medical Spanish course", "CLINICAL"],
      [true, "Dr. Spanish podcast", "AUDIO"],
      [false, "SpanishDict — conjugation", "DRILL"],
      [false, "Italki — medical tutors", "SPEAK"],
    ],
  },
  yo: {
    name: "Yoruba",
    lessons: [
      ["TUE", "Tone pair drill", "6 min · phonics"],
      ["THU", "Greetings & honorifics", "7 min · culture"],
      ["SUN", "Shadow one Yoruba song", "10 min · listening"],
    ],
    resources: [
      [true, "YorubaName — pronunciation", "AUDIO"],
      [true, "Yoruba101 — structured lessons", "COURSE"],
      [false, "BBC Yoruba — news", "READ"],
      [false, "Tandem — language partners", "SPEAK"],
    ],
  },
};

const MOOD_TILES = [
  { height: 150, background: "linear-gradient(135deg,#2a2620,#14110d)" },
  { height: 110, background: "linear-gradient(135deg,#222a30,#11161b)" },
  { height: 130, background: "linear-gradient(135deg,#2c2622,#15110e)" },
  { height: 120, background: "linear-gradient(135deg,#262a28,#121514)" },
  { height: 140, background: "linear-gradient(135deg,#28242c,#131017)" },
  { height: 100, background: "linear-gradient(135deg,#2a2724,#14110f)" },
  { height: 130, background: "linear-gradient(135deg,#212830,#10141b)" },
  { height: 115, background: "linear-gradient(135deg,#2b2620,#15110c)" },
];

function initialPins() {
  const pins: Record<string, boolean> = {};
  (Object.keys(LANG_DATA) as LangKey[]).forEach((k) => {
    LANG_DATA[k].resources.forEach(([on], i) => {
      pins[`${k}:${i}`] = on;
    });
  });
  return pins;
}

export function AtelierModule() {
  const [tab, setTab] = useState<"atl-lang" | "atl-style">("atl-lang");
  const [lang, setLang] = useState<LangKey>("fr");
  const [pins, setPins] = useState<Record<string, boolean>>(initialPins);

  const data = LANG_DATA[lang];

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
        <div className="savebtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
          Add a Pursuit
        </div>
      </div>
      <h1 className="hero">Atelier</h1>

      <div className="subtabbar" style={{ marginTop: 20 }}>
        <button type="button" className={`subtab${tab === "atl-lang" ? " on" : ""}`} onClick={() => setTab("atl-lang")}>
          Languages
        </button>
        <button type="button" className={`subtab${tab === "atl-style" ? " on" : ""}`} onClick={() => setTab("atl-style")}>
          Style
        </button>
      </div>

      <div className={`subpanel${tab === "atl-lang" ? " on" : ""}`} id="atl-lang">
        <div className="langbar">
          {LANGS.map((l) => (
            <div key={l.key} className={`langbtn${lang === l.key ? " on" : ""}`} onClick={() => setLang(l.key)}>
              {l.flag} {l.label} <span className="lv">{l.lv}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card tick">
            <h2 className="sec">This Week&apos;s Lessons<span className="rule" /><span className="count">{data.name}</span></h2>
            <div style={{ marginTop: 14 }}>
              {data.lessons.map(([day, title, meta]) => (
                <div className="lessonrow" key={`${lang}-${day}-${title}`}>
                  <div className="ld">{day}</div>
                  <div className="lt">{title}</div>
                  <div className="lmeta">{meta}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <span className="aibtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
                Add Week to Agenda
              </span>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Pinned Resources<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              {data.resources.map(([, label, type], i) => (
                <div className="resource" key={`${lang}-${label}`}>
                  <span
                    className={`pin${pins[`${lang}:${i}`] ? " on" : ""}`}
                    onClick={() => setPins((p) => ({ ...p, [`${lang}:${i}`]: !p[`${lang}:${i}`] }))}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l2.6 6.3 6.8.5-5.2 4.4 1.7 6.6L12 17l-5.9 3.3 1.7-6.6L2.6 8.8l6.8-.5z" />
                    </svg>
                  </span>
                  <span className="rl">{label}</span>
                  <span className="rt">{type}</span>
                </div>
              ))}
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 12 }}>
                Auto-refreshes weekly · click ★ to pin
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`subpanel${tab === "atl-style" ? " on" : ""}`} id="atl-style">
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card">
            <h2 className="sec">Moodboard<span className="rule" /><span className="count">Drop images to add</span></h2>
            <div className="mood" style={{ marginTop: 14 }}>
              {MOOD_TILES.map((t, i) => (
                <div key={i} style={{ height: t.height, background: t.background }} />
              ))}
            </div>
            <input type="file" accept="image/*" multiple style={{ display: "none" }} />
            <div style={{ marginTop: 12 }}>
              <span className="savebtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
                Add Images
              </span>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Men&apos;s Style — Trends<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              <div className="hl artlink"><div className="cat">SS26</div><div><div className="ht">The unstructured blazer returns, softer than ever</div><div className="hs">ESQUIRE · 1d</div></div></div>
              <div className="hl artlink"><div className="cat">Fabric</div><div><div className="ht">Why linen-silk blends are the summer flex</div><div className="hs">PERMANENT STYLE · 3d</div></div></div>
              <div className="hl artlink"><div className="cat">Grooming</div><div><div className="ht">Building a minimal warm-weather skin routine</div><div className="hs">GQ · 4d</div></div></div>
              <div className="hl artlink"><div className="cat">Fit</div><div><div className="ht">Tailoring rules for a lean, athletic frame</div><div className="hs">HE SPOKE STYLE · 5d</div></div></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
