/**
 * Supabase clients accept HTTPS origins and the repo's exact loopback HTTP
 * development origin. Other URL schemes can pass generic URL validators but
 * are rejected synchronously by the Supabase client.
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
