/**
 * Supabase accepts HTTPS origins and the exact IP loopback HTTP endpoint used
 * by the local stack. Reject every other scheme/host before client creation.
 */
export function isAllowedSupabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
