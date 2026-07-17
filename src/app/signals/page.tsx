import { permanentRedirect } from "next/navigation";

// `/signals` is a legacy duplicate of the canonical `/dispatch` route (both
// rendered the same SignalsModule). Retired to a single canonical route so the
// module never mounts under two URLs. 308 permanent redirect (DISP-3).
export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ ws?: string | string[] }> }) {
  const ws = (await searchParams).ws;
  const query = typeof ws === "string" ? `?${new URLSearchParams({ ws }).toString()}` : "";
  permanentRedirect(`/dispatch${query}`);
}
