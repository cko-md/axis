import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Axis",
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px", fontFamily: "var(--sans, system-ui)", color: "#e8e4dc", lineHeight: 1.7 }}>
      <nav style={{ marginBottom: 32, fontSize: 13, color: "#888" }}>
        <Link href="/login" style={{ color: "#c9a463", textDecoration: "none" }}>← Back</Link>
      </nav>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.02em" }}>Privacy Policy</h1>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 40 }}>Effective date: 19 June 2026</p>

      <Section title="1. Overview">
        Axis is a personal operating system for individual use. This Privacy Policy explains what data we collect, how we use it, and your rights. We follow Google&apos;s Limited Use requirements for all data obtained via Google APIs.
      </Section>

      <Section title="2. Data We Collect">
        <ul style={{ paddingLeft: 20, marginTop: 6 }}>
          <li><b>Account data:</b> email address, name, authentication credentials (managed via Supabase Auth).</li>
          <li><b>Google Calendar &amp; Gmail data:</b> event metadata, email headers and content, as authorized by you during OAuth consent.</li>
          <li><b>Microsoft Outlook data:</b> calendar events and email content, as authorized.</li>
          <li><b>Spotify data:</b> currently playing track, playback state, playlists.</li>
          <li><b>Strava data:</b> activity records, routes, performance metrics.</li>
          <li><b>Financial data (Plaid):</b> bank account balances, transactions, institution names — never raw account numbers or passwords.</li>
          <li><b>Usage data:</b> error logs via Sentry (anonymized stack traces, no PII in payloads).</li>
        </ul>
      </Section>

      <Section title="3. How We Use Your Data">
        <ul style={{ paddingLeft: 20, marginTop: 6 }}>
          <li>To provide and improve the Axis service.</li>
          <li>To display your calendar, email, health, and financial data within the app.</li>
          <li>To generate AI-powered insights using Anthropic Claude and Google Gemini APIs (prompts include only the data you explicitly surface; no data is used to train third-party models).</li>
          <li>Google user data is used only to provide the features you explicitly enable and is not shared with third parties for advertising purposes.</li>
        </ul>
      </Section>

      <Section title="4. Data Storage">
        Your data is stored in a Supabase (PostgreSQL) database protected by Row Level Security policies — only your account can access your rows. OAuth tokens are encrypted at rest. Axis does not sell your data.
      </Section>

      <Section title="5. Third-Party Services">
        Axis integrates with: Google (Calendar, Gmail, People APIs), Microsoft (Outlook), Spotify, Strava, Plaid, Anthropic (Claude AI), Google Gemini, and Sentry. Each is subject to its own privacy policy. We only request scopes necessary for the features you enable.
      </Section>

      <Section title="6. Google API Limited Use Disclosure">
        Axis&apos;s use and transfer of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" style={{ color: "#c9a463" }}>
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Google user data is used solely to provide Axis features and is not shared with or transferred to any third party for purposes unrelated to the core functionality.
      </Section>

      <Section title="7. Data Retention">
        Your data is retained for as long as your account is active. Completed tasks are automatically purged after 6 months. You can export or delete your data at any time from Control Room → Data &amp; Privacy.
      </Section>

      <Section title="8. Your Rights">
        You may: access your data, correct inaccuracies, request deletion of your account and all associated data, and withdraw consent for third-party integrations (by disconnecting them in Control Room → Integrations). To delete your account, contact us at the email below.
      </Section>

      <Section title="9. Security">
        We use HTTPS, encrypted storage, Row Level Security, and Supabase Auth (with MFA support) to protect your data. Passkeys / WebAuthn are available for passwordless authentication.
      </Section>

      <Section title="10. Changes to This Policy">
        We may update this Privacy Policy. We will notify you of significant changes via email or in-app notice. Continued use of Axis constitutes acceptance.
      </Section>

      <Section title="11. Contact">
        Privacy questions or data deletion requests:{" "}
        <a href="mailto:c.k.ogonuwe@gmail.com" style={{ color: "#c9a463" }}>c.k.ogonuwe@gmail.com</a>.
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#c9a463" }}>{title}</h2>
      <div style={{ fontSize: 14, color: "#bbb", margin: 0 }}>{children}</div>
    </section>
  );
}
