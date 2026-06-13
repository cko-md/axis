import { AppShell } from "@/components/layout/AppShell";
import { BriefingModule } from "@/components/briefing/BriefingModule";

export default function BriefingPage() {
  return (
    <AppShell section="Life" page="Briefing">
      <BriefingModule />
    </AppShell>
  );
}
