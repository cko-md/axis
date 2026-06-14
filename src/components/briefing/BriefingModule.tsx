"use client";

import { useState } from "react";

type Story = {
  id: string;
  cat: string;
  title: string;
  shortTitle: string;
  src: string;
  srcLong: string;
  body: string;
  gradient: string;
  size?: "big" | "wide";
  video?: boolean;
};

const STORIES: Story[] = [
  {
    id: "tems",
    cat: "Black & Nigerian",
    title: "Tems on Producing in Lagos and the New Wave of Afro-Fusion",
    shortTitle: "Tems on Producing in Lagos and the New Wave of Afro-Fusion",
    src: "THE NATIVE · 5h",
    srcLong: "THE NATIVE · 5h AGO · 11 MIN WATCH",
    body: "The conversation traces a deliberate creative path: building a studio ecosystem at home, resisting the pull to relocate, and treating the diaspora as a network to collaborate across rather than an audience to chase.",
    gradient: "linear-gradient(135deg,#242030,#10141b)",
    size: "big",
    video: true,
  },
  {
    id: "fus",
    cat: "Health",
    title: "Focused Ultrasound Expands Beyond Tremor Into Psychiatry Trials",
    shortTitle: "Focused Ultrasound Expands Into Psychiatry Trials",
    src: "STAT · 2h",
    srcLong: "STAT · 2h AGO · 6 MIN READ",
    body: "Trial sponsors are pushing incisionless lesioning past movement disorders into OCD and depression — with stereotactic teams watching the targeting data closely.",
    gradient: "linear-gradient(135deg,#16252a,#10141b)",
  },
  {
    id: "tsy",
    cat: "Finance",
    title: "Why Long-Duration Treasuries Are Back in Favor",
    shortTitle: "Why Long-Duration Treasuries Are Back in Favor",
    src: "BLOOMBERG · 4h",
    srcLong: "BLOOMBERG · 4h AGO · 5 MIN READ",
    body: "Duration is being treated as portfolio insurance again as growth data softens — a shift with implications for the long end of the curve.",
    gradient: "linear-gradient(135deg,#1d2330,#10141b)",
  },
  {
    id: "ondevice",
    cat: "Tech",
    title: "On-Device Models Quietly Reshape Clinical Decision Tools",
    shortTitle: "On-Device Models Reshape Clinical Decision Tools",
    src: "THE VERGE · 7h",
    srcLong: "THE VERGE · 7h AGO · 8 MIN READ",
    body: "Smaller local models are clearing privacy review faster than cloud inference, and bedside decision-support pilots are the early beneficiaries.",
    gradient: "linear-gradient(135deg,#1a2433,#10141b)",
    size: "wide",
  },
  {
    id: "semis",
    cat: "Finance",
    title: "Semis: AI Capex Durability vs. Valuation",
    shortTitle: "Semis: AI Capex Durability vs. Valuation",
    src: "FT · 1d",
    srcLong: "FT · 1d AGO · 7 MIN READ",
    body: "The bull case rests on data-center capex staying durable through 2027; the bear case is simply the multiple.",
    gradient: "linear-gradient(135deg,#22262f,#10141b)",
  },
];

const CHIPS: { label: string; f: string; on: boolean }[] = [
  { label: "All", f: "all", on: true },
  { label: "Health", f: "health", on: true },
  { label: "Tech", f: "tech", on: true },
  { label: "Style", f: "style", on: false },
  { label: "Finance", f: "finance", on: true },
  { label: "Philosophy", f: "philosophy", on: false },
  { label: "Black & Nigerian", f: "black-nigerian", on: true },
  { label: "Pop", f: "pop", on: false },
  { label: "Music", f: "music", on: false },
];

const CAT_TO_FILTER: Record<string, string> = {
  Health: "health",
  Tech: "tech",
  Finance: "finance",
  "Black & Nigerian": "black-nigerian",
};

export function BriefingModule() {
  const [active, setActive] = useState<Set<string>>(
    () => new Set(CHIPS.filter((c) => c.on).map((c) => c.f)),
  );
  const [readerId, setReaderId] = useState<string>(STORIES[0].id);

  const toggleChip = (f: string) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const visible = active.has("all")
    ? STORIES
    : STORIES.filter((s) => active.has(CAT_TO_FILTER[s.cat]));

  const reader = STORIES.find((s) => s.id === readerId) ?? STORIES[0];

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Briefing</h1>
      <div className="divider" />
      <div className="feedbar">
        <div className="feedbar-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
          <input placeholder="Describe a topic, source, or feed to follow — e.g. 'neurosurgery RCTs', 'Nigerian football', a site URL…" />
          <button type="button" className="feed-go">✦ Find Feeds</button>
        </div>
        <button type="button" className="feed-manage">Manage Sources</button>
      </div>
      <div className="feed-suggest" />
      <div className="chips">
        {CHIPS.map((c) => (
          <span
            key={c.f}
            className={`chip${active.has(c.f) ? " on" : ""}`}
            onClick={() => toggleChip(c.f)}
          >
            {c.label}
          </span>
        ))}
      </div>
      <div className="reader">
        <div className="r-media">
          <div className="play" />
          <div className="scrub">
            <span>02:14</span>
            <div className="bar" />
            <span>11:38</span>
          </div>
        </div>
        <div className="r-body">
          <div className="r-cat">{reader.cat}</div>
          <h2>{reader.title}</h2>
          <div className="r-src">{reader.srcLong}</div>
          <p>{reader.body}</p>
        </div>
      </div>
      <div className="bento">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`ncard${s.video ? " video" : ""}${s.size === "big" ? " big" : ""}${s.size === "wide" ? " wide" : ""}`}
            onClick={() => setReaderId(s.id)}
          >
            <div className="thumb" style={{ background: s.gradient }}>
              <div className="nc-cat">{s.cat}</div>
              {s.video && (
                <div className="play">
                  <span />
                </div>
              )}
            </div>
            <div className="nc-b">
              <h4>{s.shortTitle}</h4>
              <div className="nc-src">
                <span>{s.src.split(" · ")[0]}</span>
                <span>{s.src.split(" · ")[1]}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
