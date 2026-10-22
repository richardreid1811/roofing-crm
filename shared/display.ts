// Display rules shared by the finder, assistant, property drawer and leads list, kept here so they are
// unit-tested: permit status labels, honest roof-age text, and the finder's client-side sort.
import type { Row } from "./tools";

export const PERMIT_BUCKET_LABELS: Record<string, string> = {
  open: "Open",
  expired_unfinaled: "Expired, never finaled",
  closed: "Closed",
  void: "Void / cancelled",
};
// Raw source statuses that only repeat what the bucket label already says.
const SAME_AS_BUCKET: Record<string, string[]> = {
  open: ["active", "open", "issued"],
  expired_unfinaled: ["expired"],
  closed: ["final", "finaled", "closed"],
  void: ["void", "cancelled", "canceled"],
};

/**
 * One status label for a permit: the normalized bucket ("Expired, never finaled"), plus the source
 * status in parentheses only when it adds information ("Open (Suspended)"). Saved leads carry only
 * the source status of an open permit, so with no bucket an open permit's bucket is inferred.
 */
export function permitStatusLabel(status: unknown, bucket?: unknown, openPermit = false): string {
  const raw = typeof status === "string" ? status.trim() : "";
  let b = typeof bucket === "string" && bucket ? bucket : "";
  if (!b && openPermit && raw) b = /^expired$/i.test(raw) ? "expired_unfinaled" : "open";
  const base = PERMIT_BUCKET_LABELS[b];
  if (!base) return raw || "—";
  if (!raw || SAME_AS_BUCKET[b]?.includes(raw.toLowerCase())) return base;
  return `${base} (${raw})`;
}

/** Past this, an age taken from the year built says more about the building than about its roof. */
export const YEAR_BUILT_AGE_CAP = 40;
const YEAR_BUILT_BASIS = "tcad_year_built_assumes_original_roof";

/**
 * Roof age as shown in tables: "18 yrs", or for year-built estimates past 40 years
 * "≥ 40 yrs (built 1915)", since a roof that old has almost certainly been replaced without a permit
 * on record. The data itself is unchanged.
 */
export function roofAgeText(r: Row): string {
  const age = typeof r.roof_age_years === "number" ? r.roof_age_years : Number(r.roof_age_years);
  if (r.roof_age_years === null || r.roof_age_years === undefined || !Number.isFinite(age)) return "—";
  if (r.roof_age_basis === YEAR_BUILT_BASIS && age > YEAR_BUILT_AGE_CAP) {
    const built = Number(r.year_built ?? r.roof_year);
    return `≥ ${YEAR_BUILT_AGE_CAP} yrs${Number.isFinite(built) && built > 0 ? ` (built ${built})` : ""}`;
  }
  return `${age} yrs`;
}

export type SortKey = "lead_score" | "roof_age_years" | "oldest_open_years" | "distance_miles";
const numOr = (v: unknown, d: number) => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? d : x;
};
const weakEvidence = (r: Row) => (r.roof_age_confidence === "very_low" ? 1 : 0);

/**
 * Finder sort. Distance ascends, the rest descend; ties keep the query's order (score, then years
 * open). Roof age ranks very-low-confidence year-built estimates below every better-evidenced roof.
 */
export function sortRows(rows: Row[], key: SortKey): Row[] {
  const dir = key === "distance_miles" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "roof_age_years") {
      const w = weakEvidence(a) - weakEvidence(b);
      if (w) return w;
    }
    return dir * (numOr(a[key], -1) - numOr(b[key], -1));
  });
}
