// Permit-coverage caveat for assistant results. Every `leads` row carries permit_history_coverage;
// a search over an area where much of the land has no permit data (Pflugerville, unincorporated
// county, other cities) returns few permit results for that reason, not because roofs are fine.
// The note is computed deterministically here, so the model and the UI state it the same way.
import { miles, type Row, type Run } from "./tools";

export const PERMIT_COVERED = new Set([
  "austin_permit_history_1978_plus",
  "austin_etj_or_limited_purpose_permits",
  "lakeway_permit_history",
]);
/** Share of properties without permit history at or above which results get a caveat. */
export const NOTE_THRESHOLD = 0.1;

export type CoverageCount = { coverage: string | null; jurisdiction: string | null; n: number };

/** Properties within the radius, counted by permit coverage and jurisdiction. Inputs must be validated numbers. */
export const areaCoverageSql = (lat: number, lon: number, r: number) => {
  const dLat = r / 69.0;
  const dLon = r / (69.17 * Math.cos((lat * Math.PI) / 180));
  return `
    select permit_history_coverage as coverage, jurisdiction, count(*) as n
    from leads
    where latitude between ${lat - dLat} and ${lat + dLat} and longitude between ${lon - dLon} and ${lon + dLon}
      and ${miles(lat, lon)} <= ${r}
    group by 1, 2`;
};

const cityName = (j: string | null) =>
  (j ?? "")
    .replace(/^(CITY|VILLAGE|TOWN) OF /i, "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

function reason(c: CoverageCount): string {
  if (c.coverage === "no_county_building_permits_in_texas") return "unincorporated county land has no building permits";
  const city = cityName(c.jurisdiction);
  if (/^pflugerville$/i.test(city)) return "Pflugerville requires a portal login";
  if (/^lakeway$/i.test(city)) return "Lakeway permits are being added";
  return city ? `${city} permits are not ingested yet` : "those permits are not ingested yet";
}

/** A one-sentence caveat when a meaningful share of the area lacks permit history, else undefined. */
export function coverageNote(
  counts: CoverageCount[],
  toolName: string,
  scope = "properties in this area",
): string | undefined {
  const total = counts.reduce((s, c) => s + c.n, 0);
  if (!total) return undefined;
  const missing = counts.filter((c) => !PERMIT_COVERED.has(String(c.coverage)));
  const missingN = missing.reduce((s, c) => s + c.n, 0);
  if (missingN / total < NOTE_THRESHOLD) return undefined;
  // Largest gaps first; one reason each, at most three.
  const byReason = new Map<string, number>();
  for (const c of missing) byReason.set(reason(c), (byReason.get(reason(c)) ?? 0) + c.n);
  const reasons = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r]) => r);
  const pct = Math.round((100 * missingN) / total);
  const effect =
    toolName === "aged_roofs_near" || toolName === "hail_exposed_roofs_near"
      ? "roof ages there are year-built estimates and permit-based results are incomplete"
      : "open-permit results here are incomplete";
  return `${pct}% of ${scope} are in jurisdictions whose permits are not in the data (${reasons.join("; ")}), so ${effect}.`;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

/**
 * Coverage caveat for one tool result: over the searched area when the tool had a center and radius,
 * otherwise over the returned rows that carry permit_history_coverage.
 */
export async function coverageNoteFor(toolName: string, args: Row, rows: Row[], run: Run): Promise<string | undefined> {
  const lat = num(args.latitude);
  const lon = num(args.longitude);
  const r = num(args.radius_miles);
  if ([lat, lon, r].every(Number.isFinite) && r > 0) {
    const counts = (await run(areaCoverageSql(lat, lon, r))).map((c) => ({
      coverage: c.coverage == null ? null : String(c.coverage),
      jurisdiction: c.jurisdiction == null ? null : String(c.jurisdiction),
      n: num(c.n),
    }));
    return coverageNote(counts, toolName);
  }
  const tagged = rows.filter((r) => r.permit_history_coverage !== undefined);
  if (!tagged.length) return undefined;
  const counts = tagged.map((r) => ({
    coverage: r.permit_history_coverage == null ? null : String(r.permit_history_coverage),
    jurisdiction: r.jurisdiction == null ? null : String(r.jurisdiction),
    n: 1,
  }));
  return coverageNote(counts, toolName, "the returned properties");
}
