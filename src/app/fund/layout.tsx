import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { FundSubNav } from "@/components/fund/FundSubNav";
import { FundDataProvider } from "@/components/fund/FundDataProvider";

export default function FundLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell section="Capital" page="Fund">
      <FundDataProvider>
        <FundSubNav />
        {children}
      </FundDataProvider>
    </AppShell>
  );
}
