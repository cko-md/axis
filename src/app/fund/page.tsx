import { AppShell } from "@/components/layout/AppShell";
import { FundModule } from "@/components/fund/FundModule";

export default function FundPage() {
  return (
    <AppShell section="Capital" page="Fund">
      <FundModule />
    </AppShell>
  );
}
