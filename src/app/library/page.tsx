import { AppShell } from "@/components/layout/AppShell";
import { LibraryModule } from "@/components/library/LibraryModule";

export default function LibraryPage() {
  return (
    <AppShell section="Life" page="Library">
      <LibraryModule />
    </AppShell>
  );
}
