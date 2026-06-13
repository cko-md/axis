import { AppShell } from "@/components/layout/AppShell";
import { ScheduleModule } from "@/components/schedule/ScheduleModule";

export default function SchedulePage() {
  return (
    <AppShell section="Daily" page="Schedule">
      <ScheduleModule />
    </AppShell>
  );
}
