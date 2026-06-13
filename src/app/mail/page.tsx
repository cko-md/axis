import { AppShell } from "@/components/layout/AppShell";
import { MailModule } from "@/components/mail/MailModule";

export default function MailPage() {
  return (
    <AppShell section="Daily" page="Mail">
      <MailModule />
    </AppShell>
  );
}
