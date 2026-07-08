"use client";

import Link from "next/link";
import { AxisAtmosphere } from "@/components/ui/axis/AxisAtmosphere";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";

export function LandingPublic() {
  return (
    <main className="landing-page">
      <AxisAtmosphere includeStars />
      <div className="grain" aria-hidden />
      <div className="landing-content">
        <AxisReflectiveCard className="landing-hero module-hero-shell">
          <div className="font-mono text-[13px] tracking-[0.26em]">
            A<span className="text-[var(--accent)]">XIS</span>
            <sup className="text-[6.5px] text-[var(--accent-2)]">[CKO]</sup>
          </div>
          <h1 className="hero-title">Your personal operating system</h1>
          <p className="sub">
            Axis brings your calendar, email, tasks, notes, health, finances, and reading into one
            private dashboard — connected to the services you already use (Google, Microsoft,
            Spotify, Strava, Plaid) so your day lives in one place instead of a dozen tabs. It is
            built for personal, individual use; everything you connect stays yours.
          </p>
          <div className="landing-actions">
            <Link href="/login" className="landing-signin">
              Sign In
            </Link>
          </div>
        </AxisReflectiveCard>
      </div>
      <footer className="landing-footer">
        <Link href="/terms">Terms</Link>
        <span aria-hidden> · </span>
        <Link href="/privacy">Privacy</Link>
      </footer>
    </main>
  );
}
