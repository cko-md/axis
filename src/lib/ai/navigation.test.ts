import { describe, expect, it } from "vitest";
import {
  AI_INTERNAL_ACTION_PATHS,
  normalizeAiActionPath,
  sanitizeAiDeckCards,
} from "@/lib/ai/navigation";

describe("AI-authored internal navigation", () => {
  it("accepts known module roots and returns their canonical path", () => {
    expect(normalizeAiActionPath("/agenda")).toBe("/agenda");
    expect(normalizeAiActionPath(" /literature/ ")).toBe("/literature");
    for (const path of AI_INTERNAL_ACTION_PATHS) {
      expect(normalizeAiActionPath(path)).toBe(path);
    }
  });

  it.each([
    "https://evil.example/agenda",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "//evil.example/agenda",
    "///evil.example/agenda",
    "/\\evil.example",
    "/%5cevil.example",
    "/%2f%2fevil.example",
    "/%252f%252fevil.example",
    "/agenda%2f..%2ffund",
    "/agenda%3ftab%3dall",
    "/agenda/../../fund",
    "/agenda/child",
    "/agenda?next=//evil.example",
    "/agenda#//evil.example",
    "/not-an-axis-module",
    "",
  ])("rejects unsafe or unknown action path %s", (path) => {
    expect(normalizeAiActionPath(path)).toBeNull();
  });

  it("strips invalid actions while retaining safe card content", () => {
    expect(sanitizeAiDeckCards([
      {
        title: "Open agenda",
        body: "Review the next task.",
        actionLabel: "Review",
        actionPath: "/agenda",
        ignored: "model field",
      },
      {
        id: "model-controlled",
        title: "  Clean\u0000 title  ",
        body: " Body\nwith\tspacing ",
        actionLabel: "  Review  ",
        actionPath: "/agenda/",
      },
      {
        title: "External action",
        body: "This action must not cross the navigation boundary.",
        actionLabel: "Open",
        actionPath: "https://evil.example",
      },
      {
        title: "Missing path",
        body: "A label alone is not actionable.",
        actionLabel: "Open",
      },
    ])).toEqual([
      {
        id: "0",
        title: "Open agenda",
        body: "Review the next task.",
        actionLabel: "Review",
        actionPath: "/agenda",
      },
      {
        id: "1",
        title: "Clean title",
        body: "Body with spacing",
        actionLabel: "Review",
        actionPath: "/agenda",
      },
      {
        id: "2",
        title: "External action",
        body: "This action must not cross the navigation boundary.",
      },
      {
        id: "3",
        title: "Missing path",
        body: "A label alone is not actionable.",
      },
    ]);
  });
});
