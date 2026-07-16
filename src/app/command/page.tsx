import { AppShell } from "@/components/layout/AppShell";
import { ConsoleModuleLazy } from "@/components/console/ConsoleModuleLazy";

export default function CommandPage() {
  return (
    <AppShell section="Daily" page="Command">
      <ConsoleModuleLazy />
    </AppShell>
  );
}
