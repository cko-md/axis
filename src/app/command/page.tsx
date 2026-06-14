import { AppShell } from "@/components/layout/AppShell";
import { ConsoleModule } from "@/components/console/ConsoleModule";

export default function CommandPage() {
  return (
    <AppShell section="Daily" page="Command">
      <ConsoleModule />
    </AppShell>
  );
}
