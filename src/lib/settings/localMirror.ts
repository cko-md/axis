import { createClient } from "@/lib/supabase/client";

/**
 * Low-level server mirror for a single user_settings key, for components that
 * already own imperative localStorage load/save helpers and just need a
 * server copy layered on top (nav, notes folders, URL modules/boards, web
 * viewer favorites, vitality prefs, companion focus).
 *
 * Contract:
 *  - pullSetting: returns the server value (validated) for the signed-in user,
 *    or null when signed out / no row / invalid. Callers apply it over their
 *    LS-hydrated state ("server wins" for cross-device consistency), and
 *    import their local value once when the server returns null.
 *  - pushSetting: debounced per-key upsert. No-op when signed out.
 *
 * Deliberately NOT a hook: these call sites are inside existing save helpers
 * and effects, not render bodies. For fresh state-driven surfaces prefer
 * useSyncedSetting, which layers epoch guards and the LS mirror on top of the
 * same table.
 */

export async function pullSetting<T>(
  key: string,
  isValid: (value: unknown) => value is T,
): Promise<T | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("user_settings")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return isValid(data.value) ? data.value : null;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function pushSetting<T>(key: string, value: T): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(async () => {
      timers.delete(key);
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("user_settings").upsert(
        {
          user_id: user.id,
          key,
          value: value as never,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,key" },
      );
    }, 450),
  );
}

export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
