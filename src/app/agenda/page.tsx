import { AppShell } from "@/components/layout/AppShell";
import { AgendaModule } from "@/components/agenda/AgendaModule";

export default function AgendaPage() {
  return (
    <AppShell section="Daily" page="Agenda">
      <AgendaModule />
    </AppShell>
  );
}
