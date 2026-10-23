// Typed client for the Worker API.
import type { BbbRating, BbbRatingInput } from "../shared/bbb";
import type { Lead, LeadEvent, LeadInput, LeadPatch, LeadRef, Stage } from "../shared/leads";
import { WORKSPACE_HEADER, type Workspace } from "../shared/workspaces";
import { activeKey } from "./workspace";

export type Snapshot = {
  run_id: string;
  published_at: string;
  manifest_cid: string;
  root_cid: string;
  tables: Record<string, { cid: string; size: number }>;
  counts: Record<string, string>;
  gateways: string[];
  history_url: string;
  stale?: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable error from the Worker, e.g. "ai_allocation_exhausted". */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** `key` pins the workspace (null: the demo); by default each request uses the active one. */
async function call<T>(path: string, init?: RequestInit, key: string | null = activeKey()): Promise<T> {
  // A private workspace's key goes in a header; without one the Worker uses the public demo workspace.
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { [WORKSPACE_HEADER]: key } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new ApiError(body.message ?? body.error ?? `HTTP ${res.status}`, res.status, body.error);
  return body as T;
}

export const api = {
  snapshot: () => call<Snapshot>("/snapshot"),
  listLeads: (params: { stage?: Stage; q?: string; offset?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return call<{ leads: Lead[]; total: number; next_offset: number | null; counts: Record<Stage, number> }>(
      `/leads${qs ? `?${qs}` : ""}`,
    );
  },
  /** Every saved property in the workspace (id, prop_id, stage). */
  leadIndex: (key?: string | null) => call<{ leads: LeadRef[] }>("/leads/index", undefined, key),
  getLead: (id: string) => call<{ lead: Lead; events: LeadEvent[] }>(`/leads/${encodeURIComponent(id)}`),
  createLeads: (leads: LeadInput[], key?: string | null) =>
    call<{ created: Lead[]; existing: Lead[] }>("/leads", { method: "POST", body: JSON.stringify({ leads }) }, key),
  updateLead: (id: string, patch: LeadPatch) =>
    call<{ lead: Lead }>(`/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  addNote: (id: string, text: string) =>
    call<{ ok: true }>(`/leads/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ text }) }),
  deleteLead: (id: string) => call<void>(`/leads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  bbbRatings: (keys: string[]) =>
    call<{ ratings: Record<string, BbbRating> }>(`/bbb?keys=${encodeURIComponent(keys.join(","))}`),
  bbbHistory: (key: string) => call<{ history: BbbRating[] }>(`/bbb/${encodeURIComponent(key)}`),
  recordBbb: (input: BbbRatingInput) =>
    call<{ rating: BbbRating }>("/bbb", { method: "POST", body: JSON.stringify(input) }),
  deleteBbbEntry: (id: number) => call<void>(`/bbb/entries/${id}`, { method: "DELETE" }),
  workspace: () => call<{ workspace: Workspace }>("/workspaces/self"),
  createWorkspace: (name: string) =>
    call<{ workspace: Workspace; key: string }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  deleteWorkspace: () => call<void>("/workspaces/self", { method: "DELETE" }),
  chat: (messages: unknown[], mode: "auto" | "answer") =>
    call<{
      model: string;
      text: string;
      toolCalls: { toolCallId: string; toolName: string; input: unknown; error?: string }[];
    }>("/chat", { method: "POST", body: JSON.stringify({ messages, mode }) }),
};
