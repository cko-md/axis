import { AppShell } from "@/components/layout/AppShell";
import { VectorLobbyPlatformLazy } from "@/components/vector/VectorLobbyPlatformLazy";

export default function VectorPage() {
  return (
    <AppShell section="Labs" page="VECTOR">
      <VectorLobbyPlatformLazy />
    </AppShell>
  );
}
