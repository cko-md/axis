// Leaked-password check via HaveIBeenPwned's Pwned Passwords API, using
// k-anonymity: only a 5-char SHA-1 prefix ever leaves the device, never the
// password or its full hash. Supabase Auth has this built in, but only on
// the Pro plan and above — this replicates the same protection at the
// application layer so it works on any plan.
//
// Runs on Web Crypto + fetch, so it works unmodified in the browser, in
// Node 18+ API routes, and on the Edge runtime.

const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";

async function sha1Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Returns true if the password is known-leaked. Fails open (returns false)
 * on any network/API error — an HIBP outage should never block sign-up or a
 * password change. */
// Pure parse of an HIBP range response ("SUFFIX:count" per line) for a given
// suffix. Requires count > 0: with `Add-Padding: true`, HIBP injects fake
// entries with a count of 0 to obscure real result sizes, so matching on the
// suffix alone would false-positive on a padding collision and wrongly flag a
// safe password. Case-insensitive; tolerant of CRLF and blank lines.
export function rangeContainsSuffix(rangeBody: string, suffix: string): boolean {
  const target = suffix.trim().toUpperCase();
  for (const line of rangeBody.split("\n")) {
    const [hashSuffix, countStr] = line.split(":");
    if (hashSuffix && hashSuffix.trim().toUpperCase() === target) {
      return Number(countStr) > 0;
    }
  }
  return false;
}

export async function isPasswordPwned(password: string): Promise<boolean> {
  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!res.ok) return false;
    return rangeContainsSuffix(await res.text(), suffix);
  } catch {
    return false;
  }
}

export const PWNED_PASSWORD_MESSAGE =
  "This password has appeared in a known data breach. Please choose a different password.";
