import { AppShell } from "@/components/layout/AppShell";
import { MemoryCenterModule } from "@/components/memory/MemoryCenterModule";

export default function MemoryPage() {
  return <AppShell section="Operate" page="Memory"><MemoryCenterModule /></AppShell>;
}
