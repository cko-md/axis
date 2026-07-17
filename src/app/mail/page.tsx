import { AppShell } from "@/components/layout/AppShell";
import { MailModuleLazy } from "@/components/mail/MailModuleLazy";

export default function MailPage() {
  return (
    <AppShell section="Daily" page="Mail">
      <MailModuleLazy />
    </AppShell>
  );
}
