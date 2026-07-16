import { AppShell } from "@/components/layout/AppShell";
import { SignalsModuleLazy } from "@/components/signals/SignalsModuleLazy";

export default function DispatchPage() {
  return (
    <AppShell section="Daily" page="Dispatch">
      <SignalsModuleLazy />
    </AppShell>
  );
}
