import { AppShell } from "@/components/layout/AppShell";
import { ConsoleModule } from "@/components/console/ConsoleModule";

export default function ConsolePage() {
  return (
    <AppShell section="Daily" page="Console">
      <ConsoleModule />
    </AppShell>
  );
}
