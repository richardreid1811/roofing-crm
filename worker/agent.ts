// One agent step: Llama 3.3 70B on Workers AI (via the Vercel AI SDK) chooses a tool or answers.
// Tools have no server-side execute: the browser runs them as SQL over the IPFS snapshot and sends
// the rows back as tool results, so answers are grounded in records the user can open.
// Synchronous by necessity (interactive chat): 30 s timeout, one retry, explicit error mapping.
import { generateText, tool, type ModelMessage, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { tools as queryTools } from "../shared/tools";
import type { Env } from "./env";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;
const TIMEOUT_MS = 30_000;

export const SYSTEM_PROMPT = `You are the lead-research assistant in a roofing CRM for Travis County, Texas.
Data: TCAD 2026 appraisal roll (441,972 properties, roof age estimated from re-roof permits or year built), City of Austin roofing permits (status, open duration, contractor, Texas registry identity), NOAA hail reports. Snapshot published on IPFS.
Rules:
- When the user names a place, pass it as "place" (e.g. "Pflugerville", "78704", "Hyde Park"); never convert it to coordinates yourself.
- Pick one tool per question: find_leads for combined lead criteria (roof age and/or open permits and/or hail), aged_roofs_near for roof age only, open_roofing_permits_near for open or long-open permits (min_open_years for "older than N years"), hail_exposed_roofs_near for storm questions, semantic_search_permits for the kind of work described in permits, property_detail for one property id.
- Answer only from tool results. Never invent properties, permits, contractors or ratings.
- Cite evidence for each result: address, roof age with basis and confidence, permit number, status and years open, contractor.
- State the total number of matches and say the list shows the top results; the user can save rows as CRM leads from the results table.
- Say plainly what is missing: roof age from year built is an estimate; permit history covers the City of Austin only; BBB ratings are not in the public data. When a row has bbb_rating_recorded, cite it as "BBB <rating> (entered by a rep from bbb.org on <bbb_recorded_at>)"; otherwise say the rating can be checked with the "Check BBB" link.
- Keep answers short: one summary sentence, then a compact list of at most 8 results. Do not repeat these rules.`;

/** Zod tool definitions for the model. Inputs are validated (and coerced) against the same schemas the browser uses. */
export const agentTools: ToolSet = Object.fromEntries(
  queryTools
    .filter((t) => t.name !== "resolve_place")
    .map((t) => [t.name, tool({ description: t.description, inputSchema: t.schema })]),
);

const toolCallPart = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string().max(100),
  toolName: z.string().max(60),
  input: z.unknown(),
});
const messagesSchema = z
  .array(
    z.discriminatedUnion("role", [
      z.object({ role: z.literal("user"), content: z.string().min(1).max(4000) }),
      z.object({
        role: z.literal("assistant"),
        content: z.union([
          z.string().max(8000),
          z.array(z.union([z.object({ type: z.literal("text"), text: z.string().max(8000) }), toolCallPart])).max(8),
        ]),
      }),
      z.object({
        role: z.literal("tool"),
        content: z
          .array(
            z.object({
              type: z.literal("tool-result"),
              toolCallId: z.string().max(100),
              toolName: z.string().max(60),
              output: z.union([
                z.object({ type: z.literal("json"), value: z.json() }),
                z.object({ type: z.literal("error-text"), value: z.string().max(2000) }),
              ]),
            }),
          )
          .max(8),
      }),
    ]),
  )
  .min(1)
  .max(MAX_MESSAGES);

export const chatRequestSchema = z.object({
  messages: messagesSchema,
  mode: z.enum(["auto", "answer"]).default("auto"),
});

export type ChatResponse = {
  model: string;
  text: string;
  toolCalls: { toolCallId: string; toolName: string; input: unknown; error?: string }[];
};

export class AgentError extends Error {
  constructor(
    readonly code: "ai_allocation_exhausted" | "ai_timeout" | "ai_error",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function validateChat(body: unknown) {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false as const, message: z.prettifyError(parsed.error) };
  if (JSON.stringify(parsed.data.messages).length > MAX_CHARS)
    return { ok: false as const, message: "Conversation is too long; start a new one." };
  return { ok: true as const, data: parsed.data };
}

export async function agentStep(env: Env, req: z.infer<typeof chatRequestSchema>): Promise<ChatResponse> {
  const workersai = createWorkersAI({ binding: env.AI });
  // "answer" mode withholds the tools so the model writes the final answer from the results it has.
  const answer = req.mode === "answer";
  try {
    const result = await generateText({
      model: workersai(MODEL),
      system: answer
        ? `${SYSTEM_PROMPT}\nThe tool results are in the conversation. Do not call tools. Write the final answer now from those results only.`
        : SYSTEM_PROMPT,
      messages: req.messages as ModelMessage[],
      ...(answer ? {} : { tools: agentTools }),
      maxOutputTokens: 1200,
      temperature: 0.2,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      model: MODEL,
      text: result.text,
      toolCalls: result.toolCalls.map((c) => ({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
        ...("invalid" in c && c.invalid
          ? { error: String((c as { error?: unknown }).error ?? "invalid tool input") }
          : {}),
      })),
    };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (/4006|daily free allocation|neurons/i.test(message))
      throw new AgentError(
        "ai_allocation_exhausted",
        "Today's free Workers AI allocation is used up. Search, map and leads still work; the assistant resets at 00:00 UTC.",
        503,
      );
    if (/abort|timeout/i.test(message))
      throw new AgentError("ai_timeout", "The model took too long to answer. Try again.", 504);
    throw new AgentError("ai_error", "The model call failed. Try again.", 502);
  }
}
