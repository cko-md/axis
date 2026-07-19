import type { Metadata } from "next";
import { AppShell } from "@/components/layout/AppShell";
import { EnvoyLabModuleLazy } from "@/components/envoys/EnvoyLabModuleLazy";

export const metadata: Metadata = {
  title: "Envoy Lab · Axis",
  description:
    "Choose your Envoy identity and see a truthful projection of the tasks, routine runs, and approvals that need you.",
};

export default function EnvoysPage() {
  return (
    <AppShell section="Labs" page="Envoys">
      <EnvoyLabModuleLazy />
    </AppShell>
  );
}
