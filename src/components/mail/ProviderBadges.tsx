"use client";

export function ProviderDot({ provider }: { provider: "gmail" | "outlook" }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: provider === "gmail" ? "#ea4335" : "#0078d4",
        flexShrink: 0,
      }}
    />
  );
}

export function ProviderBadge({ provider }: { provider: "gmail" | "outlook" }) {
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.05em",
        padding: "1px 5px",
        borderRadius: "3px",
        background: provider === "gmail" ? "rgba(234,67,53,0.12)" : "rgba(0,120,212,0.12)",
        color: provider === "gmail" ? "#ea4335" : "#0078d4",
        flexShrink: 0,
      }}
    >
      {provider === "gmail" ? "Gmail" : "Outlook"}
    </span>
  );
}
