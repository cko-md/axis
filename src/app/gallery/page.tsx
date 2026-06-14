import { AppShell } from "@/components/layout/AppShell";
import { GalleryModule } from "@/components/gallery/GalleryModule";

export const metadata = { title: "Gallery · Axis" };

export default function GalleryPage() {
  return (
    <AppShell section="Life" page="Gallery">
      <GalleryModule />
    </AppShell>
  );
}
