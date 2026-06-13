import { AppShell } from "@/components/layout/AppShell";
import { ObjectivesModule } from "@/components/objectives/ObjectivesModule";

export default function ObjectivesPage() {
  return (
    <AppShell section="Plan" page="Objectives">
      <ObjectivesModule />
    </AppShell>
  );
}
