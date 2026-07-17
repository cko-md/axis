import { AppShell } from "@/components/layout/AppShell";
import { NotesModuleLazy } from "@/components/notes/NotesModuleLazy";

export default function NotesPage() {
  return (
    <AppShell section="Daily" page="Notes">
      <NotesModuleLazy />
    </AppShell>
  );
}
