import { NextResponse } from "next/server";

// The generic Composio deputy accepted caller-selected tool names and has no
// production caller. Provider work is dispatched only through domain adapters
// that bind a canonical toolkit/capability/operation to an opaque local
// connection id and perform exact authority proof immediately before execution.
export async function POST() {
  return NextResponse.json(
    {
      error: "The generic provider execution endpoint has been retired.",
      code: "generic_provider_dispatch_retired",
    },
    { status: 410 },
  );
}
