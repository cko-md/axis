import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { FundDataProvider } from "@/components/fund/FundDataProvider";
import { FundPremiumShell } from "@/components/fund/FundPremiumShell";

export default function FundLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell section="Capital" page="Fund">
      <FundDataProvider>
        <FundPremiumShell>{children}</FundPremiumShell>
      </FundDataProvider>
    </AppShell>
  );
}
