// BBB ratings recorded by reps: a rep opens BBB's own search ("Check BBB"), reads the rating and records
// it here. The app never fetches BBB (no public API; automated access is blocked).
import { z } from "zod";

export const BBB_RATINGS = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D+",
  "D",
  "D-",
  "F",
  "NR",
  "not_found",
] as const;
export type BbbRatingValue = (typeof BBB_RATINGS)[number];
export const BBB_RATING_LABEL = (r: string) =>
  r === "NR" ? "NR (not rated)" : r === "not_found" ? "No BBB profile found" : r;

/** Pipeline contractor key: `contractor:<md5 of the normalized name>`, stable across snapshots. */
export const contractorKeySchema = z.string().regex(/^contractor:[0-9a-f]{32}$/, "pipeline contractor key");

const optText = (max: number) =>
  z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(max).nullable().optional());

export const bbbRatingInputSchema = z
  .object({
    contractor_key: contractorKeySchema,
    contractor_name: z.string().trim().min(1).max(200),
    rating: z.enum(BBB_RATINGS),
    accredited: z.boolean().nullable().optional(),
    profile_url: z.preprocess(
      (v) => (v === "" ? null : v),
      z
        .string()
        .url()
        .max(400)
        .refine((u) => /^https:\/\/(www\.)?bbb\.org\//.test(u), "must be a https://www.bbb.org/ link")
        .nullable()
        .optional(),
    ),
    recorded_by: optText(80),
    note: optText(500),
  })
  .strict();
export type BbbRatingInput = z.input<typeof bbbRatingInputSchema>;

export type BbbRating = {
  id: number;
  contractor_key: string;
  contractor_name: string;
  rating: BbbRatingValue;
  accredited: boolean | null;
  profile_url: string | null;
  recorded_by: string | null;
  note: string | null;
  recorded_at: string;
};
