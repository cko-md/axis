import { AppShell } from "@/components/layout/AppShell";
import { PipelineModule } from "@/components/pipeline/PipelineModule";

export default function PipelinePage() {
  return (
    <AppShell section="Research" page="Pipeline">
      <PipelineModule />
    </AppShell>
  );
}
