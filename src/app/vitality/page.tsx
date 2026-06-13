import { AppShell } from "@/components/layout/AppShell";
import { VitalityModule } from "@/components/vitality/VitalityModule";

export default function VitalityPage() {
  return (
    <AppShell section="Life" page="Vitality">
      <VitalityModule />
    </AppShell>
  );
}
