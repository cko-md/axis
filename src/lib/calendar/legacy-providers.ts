import { getFreshAccessToken, type CalendarProvider } from "./tokens";

function isCalendarProvider(value: string): value is CalendarProvider {
  return value === "google" || value === "outlook";
}

/** Legacy OAuth rows that still have a refreshable access token. */
export async function listHealthyLegacyProviders(
  userId: string,
  connectionRows: readonly { provider: string }[],
): Promise<Set<CalendarProvider>> {
  const candidates = [...new Set(connectionRows.map((row) => row.provider).filter(isCalendarProvider))];
  const healthy = new Set<CalendarProvider>();

  await Promise.all(
    candidates.map(async (provider) => {
      const token = await getFreshAccessToken(userId, provider);
      if (token) healthy.add(provider);
    }),
  );

  return healthy;
}
