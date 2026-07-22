import { createClient } from "@/lib/supabase/client";

/**
 * Server sync for sidebar nav customization (item order, group order, item
 * labels, group labels). These lived only in localStorage — four keys under
 * axis-nav-* — so a user's carefully arranged sidebar reset on every new
 * device or browser-data clear, even though user_preferences.nav_order has
 * existed unused since migration 002.
 *
 * Rather than reuse that single-column shape (it can't hold labels + group
 * order), this consolidates all four into one user_settings row under
 * "nav.customization". localStorage stays the fast-path mirror; the helpers
 * here reconcile it with the server.
 */

const SETTINGS_KEY = "nav.customization";

export type NavCustomization = {
  order: Record<string, string[]>;
  groupOrder: string[];
  labels: Record<string, string>;
  groupLabels: Record<string, string>;
};

export function isNavCustomization(value: unknown): value is NavCustomization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.order === "object"
    && candidate.order !== null
    && Array.isArray(candidate.groupOrder)
    && typeof candidate.labels === "object"
    && candidate.labels !== null
    && typeof candidate.groupLabels === "object"
    && candidate.groupLabels !== null
  );
}

export function isEmptyCustomization(value: NavCustomization): boolean {
  return (
    Object.keys(value.order).length === 0
    && value.groupOrder.length === 0
    && Object.keys(value.labels).length === 0
    && Object.keys(value.groupLabels).length === 0
  );
}

/** Load the server-stored customization for the signed-in user, if any. */
export async function loadNavCustomizationFromServer(): Promise<NavCustomization | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("user_settings")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  if (error || !data) return null;
  return isNavCustomization(data.value) ? data.value : null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced upsert of the full customization object. No-op when signed out. */
export function saveNavCustomizationToServer(value: NavCustomization): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("user_settings").upsert(
      {
        user_id: user.id,
        key: SETTINGS_KEY,
        value: value as never,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,key" },
    );
  }, 450);
}
