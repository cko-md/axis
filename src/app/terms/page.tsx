import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Axis",
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px", fontFamily: "var(--sans, system-ui)", color: "#e8e4dc", lineHeight: 1.7 }}>
      <nav style={{ marginBottom: 32, fontSize: 13, color: "#888" }}>
        <Link href="/login" style={{ color: "#c9a463", textDecoration: "none" }}>← Back</Link>
      </nav>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.02em" }}>Terms of Service</h1>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 40 }}>Effective date: 19 June 2026</p>

      <Section title="1. Acceptance">
        By creating an Axis account, you agree to these Terms of Service ("Terms"). If you do not agree, do not use Axis.
      </Section>

      <Section title="2. Description of Service">
        Axis is a personal operating system that connects to third-party services (Google Calendar, Gmail, Microsoft Outlook, Spotify, Strava, Plaid, and others) to help you manage your day, finances, health, and creative life. The service is provided as-is for personal, non-commercial use.
      </Section>

      <Section title="3. Accounts">
        You are responsible for maintaining the confidentiality of your credentials and for all activity under your account. You must be at least 13 years old to use Axis. Provide accurate information when registering.
      </Section>

      <Section title="4. Third-Party Integrations">
        Axis connects to third-party platforms on your behalf. Your use of those platforms is governed by their respective terms of service. Axis is not affiliated with or endorsed by Google, Microsoft, Spotify, Strava, or Plaid.
      </Section>

      <Section title="5. Acceptable Use">
        You agree not to use Axis to: (a) violate any applicable law; (b) interfere with the service or its infrastructure; (c) reverse-engineer or attempt to extract the source code; (d) use automated means to scrape or abuse the service.
      </Section>

      <Section title="6. Data & Privacy">
        Your use of data collected by Axis is governed by our{" "}
        <Link href="/privacy" style={{ color: "#c9a463" }}>Privacy Policy</Link>. You retain ownership of your personal data. You may request deletion of your account and associated data at any time by contacting us.
      </Section>

      <Section title="7. Disclaimers">
        Axis is provided "as is" without warranty of any kind. Financial data, health metrics, and other information displayed are for informational purposes only and do not constitute financial, medical, or professional advice.
      </Section>

      <Section title="8. Limitation of Liability">
        To the maximum extent permitted by law, Axis shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the service.
      </Section>

      <Section title="9. Termination">
        You may delete your account at any time. We reserve the right to suspend or terminate accounts that violate these Terms.
      </Section>

      <Section title="10. Changes to Terms">
        We may update these Terms from time to time. Continued use of Axis after changes constitutes acceptance of the revised Terms.
      </Section>

      <Section title="11. Governing Law">
        These Terms are governed by the laws of the jurisdiction in which Axis is operated, without regard to conflict of law provisions.
      </Section>

      <Section title="12. Contact">
        Questions about these Terms? Contact us at{" "}
        <a href="mailto:c.k.ogonuwe@gmail.com" style={{ color: "#c9a463" }}>c.k.ogonuwe@gmail.com</a>.
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#c9a463" }}>{title}</h2>
      <p style={{ fontSize: 14, color: "#bbb", margin: 0 }}>{children}</p>
    </section>
  );
}
