import Link from "next/link";
import { AxisAtmosphere } from "@/components/ui/axis/AxisAtmosphere";

export default function NotFound() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 12, color: "var(--ink)", fontFamily: "var(--mono)" }}>
      <AxisAtmosphere />
      <div className="grain" aria-hidden />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".12em", color: "var(--ink-faint)" }}>404</div>
        <div style={{ fontSize: 14, color: "var(--ink-dim)" }}>Page not found</div>
        <Link href="/command" style={{ marginTop: 8, fontSize: 11, color: "var(--accent)", textDecoration: "none", letterSpacing: ".06em" }}>
          ← Back to Command
        </Link>
      </div>
    </div>
  );
}
