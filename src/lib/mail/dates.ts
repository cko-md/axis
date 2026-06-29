type MailDateLike = {
  date?: string;
  id?: string;
  provider?: string;
  accountEmail?: string;
};

function parseNumericTimestamp(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  const millis = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseMailDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") return parseNumericTimestamp(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseNumericTimestamp(Number(trimmed));
  }

  const millis = Date.parse(trimmed);
  if (Number.isNaN(millis)) return null;
  return new Date(millis);
}

export function normalizeMailDate(value: unknown): string {
  return parseMailDate(value)?.toISOString() ?? "";
}

export function getMailDateTime(value: unknown): number | null {
  return parseMailDate(value)?.getTime() ?? null;
}

export function compareMailIdentity(a: MailDateLike, b: MailDateLike): number {
  const aKey = `${a.provider ?? ""}:${a.accountEmail ?? ""}:${a.id ?? ""}`;
  const bKey = `${b.provider ?? ""}:${b.accountEmail ?? ""}:${b.id ?? ""}`;
  return aKey.localeCompare(bKey);
}

export function compareMailDateDesc(a: MailDateLike, b: MailDateLike): number {
  const aTime = getMailDateTime(a.date);
  const bTime = getMailDateTime(b.date);

  if (aTime === null && bTime === null) return compareMailIdentity(a, b);
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  if (aTime !== bTime) return bTime - aTime;
  return compareMailIdentity(a, b);
}
