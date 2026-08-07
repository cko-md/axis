import React from "react";
import type { PoemPayload } from "@/lib/content/poems";

export function PoemSourceNotice({ source }: Pick<PoemPayload, "source">) {
  if (source !== "local") return null;

  return (
    <div className="g-poem-source-status" role="status">
      PoetryDB unavailable — showing a bundled poem.
    </div>
  );
}
