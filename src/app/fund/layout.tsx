import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { FundSubNav } from "@/components/fund/FundSubNav";

export default function FundLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell section="Capital" page="Fund">
      <FundSubNav />
      {children}
    </AppShell>
  );
}
