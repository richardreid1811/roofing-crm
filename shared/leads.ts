// CRM lead records: the shared contract between the UI and the Worker API (stored in D1).
import { z } from "zod";

export const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal sent",
  won: "Won",
  lost: "Lost",
};
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Stage = (typeof STAGES)[number];
export type Priority = (typeof PRIORITIES)[number];

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(max).nullable().optional());

/** Evidence captured when the lead is created, so the record stays meaningful after new snapshots. */
export const signalsSchema = z
  .object({
    roof_age_years: z.number().nullable().optional(),
    roof_year: z.number().nullable().optional(),
    roof_age_basis: z.string().max(80).nullable().optional(),
    roof_age_confidence: z.string().max(20).nullable().optional(),
    roof_covering: z.string().max(40).nullable().optional(),
    open_permit_number: z.string().max(40).nullable().optional(),
    open_permit_status: z.string().max(60).nullable().optional(),
    open_permit_years: z.number().nullable().optional(),
    contractor: z.string().max(160).nullable().optional(),
    contractor_identity: z.string().max(60).nullable().optional(),
    contractor_key: z.string().max(60).nullable().optional(),
    bbb_rating: z.string().max(10).nullable().optional(),
    severe_hail_reports: z.number().nullable().optional(),
    lead_score: z.number().nullable().optional(),
    permit_history_coverage: z.string().max(80).nullable().optional(),
  })
  .strict();
export type Signals = z.infer<typeof signalsSchema>;

export const leadInputSchema = z.object({
  prop_id: z.string().regex(/^\d{1,12}$/, "TCAD property id (digits)"),
  address: text(200).min(1),
  latitude: z.number().min(29.9).max(30.7).nullable().optional(),
  longitude: z.number().min(-98.3).max(-97.3).nullable().optional(),
  owner_name: optText(200),
  permit_number: optText(40),
  source: z.enum(["finder", "agent", "property"]).default("finder"),
  source_run_id: text(40).min(1),
  source_url: z
    .string()
    .url()
    .max(400)
    .refine((u) => u.startsWith("https://"), "https only")
    .nullable()
    .optional(),
  priority: z.enum(PRIORITIES).default("medium"),
  signals: signalsSchema.default({}),
});
export type LeadInput = z.input<typeof leadInputSchema>;

/** Leads per save request (one D1 batch); the client splits larger selections. */
export const MAX_LEADS_PER_SAVE = 100;
export const createLeadsSchema = z.object({ leads: z.array(leadInputSchema).min(1).max(MAX_LEADS_PER_SAVE) });

export const leadPatchSchema = z
  .object({
    stage: z.enum(STAGES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee: optText(80),
    next_action: optText(200),
    next_action_date: z.preprocess(
      (v) => (v === "" ? null : v),
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    ),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "nothing to update");
export type LeadPatch = z.input<typeof leadPatchSchema>;

export const noteSchema = z.object({ text: text(2000).min(1) });

export type Lead = {
  id: string;
  prop_id: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  owner_name: string | null;
  permit_number: string | null;
  stage: Stage;
  priority: Priority;
  assignee: string | null;
  next_action: string | null;
  next_action_date: string | null;
  source: string;
  source_run_id: string;
  source_url: string | null;
  signals: Signals;
  created_at: string;
  updated_at: string;
};

/** What the saved-property index needs: whether a property is a lead, and which one. */
export type LeadRef = Pick<Lead, "id" | "prop_id" | "stage">;

/** Leads per list page (GET /leads); the list asks for further pages with `offset`. */
export const LEADS_PAGE = 200;
export const MAX_LEADS_PAGE = 500;

export type LeadEvent = {
  id: number;
  lead_id: string;
  at: string;
  kind: "created" | "stage" | "update" | "note";
  detail: string;
};
