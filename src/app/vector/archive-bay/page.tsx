import type { Metadata } from "next";
import { AppShell } from "@/components/layout/AppShell";
import { ArchiveBayModuleLazy } from "@/components/vector/ArchiveBayModuleLazy";

export const metadata: Metadata = {
  title: "Archive Bay · VECTOR · Axis",
  description:
    "Launch legacy titles you already own through an emulator you already installed. Desktop-only; no system files, firmware, or emulators are included or provided.",
};

export default function ArchiveBayPage() {
  return (
    <AppShell section="Labs" page="VECTOR">
      <ArchiveBayModuleLazy />
    </AppShell>
  );
}
