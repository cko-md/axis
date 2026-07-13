import { AppShell } from "@/components/layout/AppShell";
import { ApprovalsModule } from "@/components/approvals/ApprovalsModule";

export default function ApprovalsPage() {
  return (
    <AppShell section="Operate" page="Approvals">
      <ApprovalsModule />
    </AppShell>
  );
}
