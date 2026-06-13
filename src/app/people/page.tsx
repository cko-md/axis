import { AppShell } from "@/components/layout/AppShell";
import { PeopleModule } from "@/components/people/PeopleModule";

export default function PeoplePage() {
  return (
    <AppShell section="Life" page="People">
      <PeopleModule />
    </AppShell>
  );
}
