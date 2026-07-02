import { permanentRedirect } from "next/navigation";

// `/console` is a legacy duplicate of the canonical `/command` route (both
// rendered the same ConsoleModule). Retired to a single canonical route so the
// module never mounts under two URLs. 308 permanent redirect (DISP-3).
export default function ConsolePage() {
  permanentRedirect("/command");
}
