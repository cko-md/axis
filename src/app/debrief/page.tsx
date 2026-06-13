import { AppShell } from "@/components/layout/AppShell";
import { DebriefModule } from "@/components/debrief/DebriefModule";

export default function DebriefPage() {
  return (
    <AppShell section="Plan" page="Debrief">
      <DebriefModule />
    </AppShell>
  );
}
