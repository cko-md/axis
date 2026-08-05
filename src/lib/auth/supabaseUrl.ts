export const AXIS_SUPABASE_PRODUCTION_ORIGIN =
  "https://twkcvyhmlguipchfetge.supabase.co";
export const AXIS_SUPABASE_LOCAL_ORIGIN = "http://127.0.0.1:54321";

/**
 * Pin authentication traffic to AXIS's production project or the documented
 * local stack. Origin-only form prevents credentials, paths, query strings,
 * fragments, or alternate ports from changing the authority or request base.
 */
export function isAllowedSupabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return false;
    }
    return parsed.origin === AXIS_SUPABASE_PRODUCTION_ORIGIN
      || parsed.origin === AXIS_SUPABASE_LOCAL_ORIGIN;
  } catch {
    return false;
  }
}
