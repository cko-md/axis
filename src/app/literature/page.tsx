import { AppShell } from "@/components/layout/AppShell";
import { LiteratureModule } from "@/components/literature/LiteratureModule";

export default function LiteraturePage() {
  return (
    <AppShell section="Research" page="Literature">
      <LiteratureModule />
    </AppShell>
  );
}
