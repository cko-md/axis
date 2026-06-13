import { AppShell } from "@/components/layout/AppShell";
import { NotesModule } from "@/components/notes/NotesModule";

export default function NotesPage() {
  return (
    <AppShell section="Daily" page="Notes">
      <NotesModule />
    </AppShell>
  );
}
