import { seededIndex } from "@/lib/content/daily";

/**
 * The Command hero sentence. Previously two fixed templates — the closing
 * clause was the literal "and the morning block is yours." at any hour of the
 * day. This builds the line from what is actually true right now (open /
 * overdue / done-today counts, the next calendar event, the local hour) and
 * rotates phrasing daily with the shared seeded pick, so the sentence is
 * reflexive rather than a static greeting.
 *
 * Pure and deterministic: same context in, same sentence out — unit-testable
 * and no re-roll on re-render.
 */

export type HeroContext = {
  openCount: number;
  overdueCount: number;
  dueTodayCount: number;
  doneTodayCount: number;
  /** Next event still ahead of now, if any. */
  nextEvent: { title: string; minutesUntil: number; timeLabel: string } | null;
  /** Local hour 0–23. */
  hour: number;
  /** localDayNumber() — the daily rotation seed. */
  daySeed: number;
};

export type HeroSentence =
  | { kind: "first-run" }
  | { kind: "line"; lead: string; em: string; tail: string };

type TimeOfDay = "late" | "morning" | "afternoon" | "evening";

export function timeOfDay(hour: number): TimeOfDay {
  if (hour < 5) return "late";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

const NEUTRAL_EM = [
  "nothing overdue",
  "a clear runway",
  "no deadlines pressing",
] as const;

const OVERDUE_TAILS = [
  "clear the overdue first — then the day is yours.",
  "oldest debt first; momentum after.",
  "settle what slipped, and the rest gets lighter.",
] as const;

const TIME_TAILS: Record<TimeOfDay, readonly string[]> = {
  late: [
    "nothing here needs you before morning.",
    "the night is for rest — tomorrow is already staged.",
    "the quiet hours are cover; take them.",
  ],
  morning: [
    "the morning block is yours.",
    "the day is still unwritten — write the first line.",
    "momentum starts with the next thirty minutes.",
    "first light, first move.",
  ],
  afternoon: [
    "the afternoon stretch is open.",
    "midday is a hinge — swing it your way.",
    "there's still daylight on the board.",
  ],
  evening: [
    "the evening is for closing loops.",
    "wind down deliberately — tomorrow will thank you.",
    "one more push, then rest with a clear head.",
  ],
};

const CLEAR_TAILS: Record<TimeOfDay, readonly string[]> = {
  late: ["let the night stay quiet.", "sleep on a clean board."],
  morning: ["the whole day is open ground.", "start something worth finishing."],
  afternoon: ["the afternoon is found time.", "spend the surplus deliberately."],
  evening: ["let the evening be unhurried.", "bank the momentum for tomorrow."],
};

// Salts keep each pool's daily rotation independent — without them every
// pool of the same length would advance in lockstep.
const SALT_EM = 11;
const SALT_OVERDUE = 23;
const SALT_TIME = 37;
const SALT_EVENT = 41;
const SALT_CLEAR = 43;

function pickFrom(pool: readonly string[], daySeed: number, salt: number): string {
  return pool[seededIndex(daySeed, pool.length, salt)];
}

export function buildHeroSentence(ctx: HeroContext): HeroSentence {
  const tod = timeOfDay(ctx.hour);

  if (ctx.openCount === 0) {
    // Nothing open and nothing done yet — the true first-run/blank state.
    // The caller renders the canonical capture prompt (it references the
    // capture bar physically below the hero, so its wording stays put).
    if (ctx.doneTodayCount === 0) return { kind: "first-run" };
    return {
      kind: "line",
      lead: "A clean board",
      em: `${ctx.doneTodayCount} closed today`,
      tail: pickFrom(CLEAR_TAILS[tod], ctx.daySeed, SALT_CLEAR),
    };
  }

  const lead = `${ctx.openCount} open ${ctx.openCount === 1 ? "task" : "tasks"}`;

  const em = ctx.overdueCount > 0
    ? `${ctx.overdueCount} overdue`
    : ctx.dueTodayCount > 0
      ? `${ctx.dueTodayCount} due today`
      : ctx.doneTodayCount > 0
        ? `${ctx.doneTodayCount} closed today`
        : pickFrom(NEUTRAL_EM, ctx.daySeed, SALT_EM);

  // Tail precedence: overdue debts outrank the calendar; the calendar
  // outranks generic time-of-day phrasing (but only while the gap is
  // actionable); late-night overrides the nudge to work.
  let tail: string;
  if (ctx.overdueCount > 0 && tod !== "late") {
    tail = pickFrom(OVERDUE_TAILS, ctx.daySeed, SALT_OVERDUE);
  } else if (
    ctx.nextEvent
    && ctx.nextEvent.minutesUntil >= 10
    && ctx.nextEvent.minutesUntil <= 150
  ) {
    const { title, timeLabel } = ctx.nextEvent;
    tail = seededIndex(ctx.daySeed, 2, SALT_EVENT) === 0
      ? `${title} at ${timeLabel} — the gap before it is yours.`
      : `next up: ${title} at ${timeLabel}. Work the gap.`;
  } else {
    tail = pickFrom(TIME_TAILS[tod], ctx.daySeed, SALT_TIME);
  }

  return { kind: "line", lead, em, tail };
}
