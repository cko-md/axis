import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Axis — Personal Operating System",
  description:
    "Axis is a personal operating system: one private dashboard for your calendar, email, tasks, notes, health, finances, and reading — connected to the services you already use.",
};

export default async function HomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/command");

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--ink)" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontFamily: "var(--mono, monospace)", fontSize: 14, letterSpacing: "0.26em" }}>
          A<span style={{ color: "var(--accent)" }}>XIS</span>
          <sup style={{ fontSize: 7, color: "var(--accent-2, var(--gold))" }}>[CKO]</sup>
        </div>

        <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 18, maxWidth: 560 }}>
          Your personal operating system
        </h1>

        <p style={{ fontSize: 15, color: "var(--ink-dim)", marginTop: 16, maxWidth: 520, lineHeight: 1.7 }}>
          Axis brings your calendar, email, tasks, notes, health, finances, and reading into one
          private dashboard — connected to the services you already use (Google, Microsoft,
          Spotify, Strava, Plaid) so your day lives in one place instead of a dozen tabs. It is
          built for personal, individual use; everything you connect stays yours.
        </p>

        <div style={{ display: "flex", gap: 12, marginTop: 32 }}>
          <Link
            href="/login"
            style={{
              fontFamily: "var(--mono, monospace)",
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              padding: "10px 22px",
              borderRadius: "var(--r, 6px)",
              background: "var(--accent)",
              color: "var(--on-accent, #fff)",
              textDecoration: "none",
            }}
          >
            Sign In
          </Link>
        </div>
      </div>

      <footer style={{ padding: "20px 24px", textAlign: "center", fontSize: 12, color: "var(--ink-faint)" }}>
        <Link href="/terms" style={{ color: "var(--ink-faint)", textDecoration: "none" }}>Terms</Link>
        <span style={{ margin: "0 8px" }}>·</span>
        <Link href="/privacy" style={{ color: "var(--ink-faint)", textDecoration: "none" }}>Privacy</Link>
      </footer>
    </main>
  );
}
