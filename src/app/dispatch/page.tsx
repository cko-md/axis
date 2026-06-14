import { AppShell } from "@/components/layout/AppShell";
import { SignalsModule } from "@/components/signals/SignalsModule";

export default function DispatchPage() {
  return (
    <AppShell section="Daily" page="Dispatch">
      <SignalsModule />
    </AppShell>
  );
}
