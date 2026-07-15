import { AppShell } from "@/components/layout/AppShell";
import { TasksModule } from "@/components/tasks/TasksModule";

export default function TasksPage() {
  return (
    <AppShell section="Operate" page="Tasks">
      <TasksModule />
    </AppShell>
  );
}
