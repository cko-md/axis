import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

export const aiWorkflowStatusSchema = z.object({
  ok: z.boolean(),
  workflow: z.string(),
  model: z.string().optional(),
  fallback: z.boolean().default(false),
  message: z.string().optional(),
});

export type AIWorkflowStatus = z.infer<typeof aiWorkflowStatusSchema>;

export type AIWorkflowDefinition<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> = {
  id: string;
  label: string;
  input: Input;
  output: Output;
  fallback: (input: z.infer<Input>) => z.infer<Output>;
};

export const aiWorkflowRegistry = {
  "briefing.generate": {
    id: "briefing.generate",
    label: "Briefing generation",
    input: z.object({
      items: z.array(z.object({
        title: z.string(),
        source: z.string().optional(),
        summary: z.string().optional(),
      })).max(20),
    }),
    output: z.object({
      brief: z.string(),
      highlights: z.array(z.string()).default([]),
    }),
    fallback: (input: { items: Array<{ title: string }> }) => ({
      brief: input.items.slice(0, 5).map((item) => item.title).join("\n"),
      highlights: input.items.slice(0, 3).map((item) => item.title),
    }),
  },
  "mail.triage": {
    id: "mail.triage",
    label: "Mail triage",
    input: z.object({
      subject: z.string(),
      body: z.string().optional(),
    }),
    output: z.object({
      title: z.string(),
      priority: z.enum(["hi", "med", "lo"]),
      category: z.string(),
      effort: z.string(),
    }),
    fallback: (input) => ({
      title: input.subject || "Mail item",
      priority: /urgent|asap|critical/i.test(`${input.subject} ${input.body ?? ""}`) ? "hi" : "med",
      category: "mail",
      effort: "~15m",
    }),
  },
  "notes.title": {
    id: "notes.title",
    label: "Note title",
    input: z.object({
      text: z.string(),
    }),
    output: z.object({
      title: z.string(),
    }),
    fallback: (input) => ({
      title: input.text.split(/[\n.!?]/)[0]?.trim().slice(0, 80) || "Untitled",
    }),
  },
} satisfies Record<string, AIWorkflowDefinition<z.ZodTypeAny, z.ZodTypeAny>>;

export type AIWorkflowId = keyof typeof aiWorkflowRegistry;

export function workflowDefinition(id: AIWorkflowId) {
  return aiWorkflowRegistry[id];
}

export async function runTypedAIWorkflow<Id extends AIWorkflowId>(
  id: Id,
  rawInput: unknown,
  runModel: (input: z.infer<(typeof aiWorkflowRegistry)[Id]["input"]>) => Promise<unknown>,
): Promise<z.infer<(typeof aiWorkflowRegistry)[Id]["output"]> & AIWorkflowStatus> {
  const workflow = aiWorkflowRegistry[id] as AIWorkflowDefinition<z.ZodTypeAny, z.ZodTypeAny>;
  const input = workflow.input.parse(rawInput);

  try {
    const rawOutput = await runModel(input);
    const output = workflow.output.parse(rawOutput);
    return { ...output, ok: true, workflow: id, fallback: false } as z.infer<(typeof aiWorkflowRegistry)[Id]["output"]> & AIWorkflowStatus;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: "ai",
        workflow: id,
        code: error instanceof z.ZodError ? "schema_validation" : "provider_error",
      },
      level: "warning",
    });
    const fallback = workflow.fallback(input);
    const output = workflow.output.parse(fallback);
    return {
      ...output,
      ok: false,
      workflow: id,
      fallback: true,
      message: "AI workflow used a deterministic fallback.",
    } as z.infer<(typeof aiWorkflowRegistry)[Id]["output"]> & AIWorkflowStatus;
  }
}
