import { AppShell } from "@/components/layout/AppShell";
import { ControlRoomModule } from "@/components/control-room/ControlRoomModule";

export default function ControlRoomPage() {
  return (
    <AppShell section="System" page="Control Room">
      <ControlRoomModule />
    </AppShell>
  );
}
