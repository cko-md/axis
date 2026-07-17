import { AppShell } from "@/components/layout/AppShell";
import { DesignSystemGallery } from "@/components/design-system/DesignSystemGallery";

export default function DesignSystemPage() {
  return (
    <AppShell section="System" page="Design System">
      <DesignSystemGallery />
    </AppShell>
  );
}
