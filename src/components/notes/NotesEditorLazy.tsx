"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { NotesEditorSkeleton } from "./NotesEditorSkeleton";
import type { NotesEditor as NotesEditorComponent } from "./NotesEditor";

// NOTES-1: the TipTap editor (StarterKit + tables + task lists + code-block
// highlighting via lowlight's `common` language pack) is a large client-only
// bundle. It was statically imported into NotesModule, so every /notes visit
// paid for it up front even before a note was opened. Loading it through
// next/dynamic with ssr:false splits it into its own chunk fetched on demand,
// with a themed skeleton while it streams in. ssr:false is correct here — the
// editor is client-only (uses the DOM/window) and never rendered on the server.
export const NotesEditor = dynamic(
  () => import("./NotesEditor").then((m) => m.NotesEditor),
  {
    ssr: false,
    loading: () => <NotesEditorSkeleton />,
  },
) as typeof NotesEditorComponent;

export type NotesEditorProps = ComponentProps<typeof NotesEditorComponent>;
