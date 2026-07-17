import { AppShell } from "@/components/layout/AppShell";
import { VitalityModuleLazy } from "@/components/vitality/VitalityModuleLazy";

export default function VitalityPage() {
  return (
    <AppShell section="Life" page="Vitality">
      <VitalityModuleLazy />
    </AppShell>
  );
}
