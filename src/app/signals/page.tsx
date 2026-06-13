import { AppShell } from "@/components/layout/AppShell";
import { SignalsModule } from "@/components/signals/SignalsModule";

export default function SignalsPage() {
  return (
    <AppShell section="Daily" page="Signals">
      <SignalsModule />
    </AppShell>
  );
}
