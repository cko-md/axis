import { Card } from "@/components/ui/Card";

export default function FundAdvisorPage() {
  return (
    <Card tick>
      <h2 className="sec">AI Advisor<span className="rule" /><span className="count">Phase 5</span></h2>
      <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.7, marginTop: 10 }}>
        Tool-calling chat over your financial data — daily brief, weekly recap, budget review,
        portfolio review, subscription audit, scenario analysis — lands once the AI tool schemas
        and safe-response rules (Phase 5) are designed. The tables it will read and write
        (ai_conversations, ai_messages, ai_tool_calls, ai_insights) already exist.
      </p>
    </Card>
  );
}
