import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { StatusCallout } from "@/components/ui/StatusCallout";
import styles from "@/components/vector/Vector.module.css";

export default function VectorGameNotFound() {
  return (
    <AppShell section="Labs" page="Unknown VECTOR game" suppressPresence>
      <div className={styles.unknownState} data-testid="vector-game-unknown">
        <StatusCallout kind="error" title="This VECTOR game does not exist.">
          The route is not present in the reviewed game registry. No loader or save was opened.
        </StatusCallout>
        <Link href="/vector" className={styles.primaryLink}>Return to VECTOR</Link>
      </div>
    </AppShell>
  );
}
