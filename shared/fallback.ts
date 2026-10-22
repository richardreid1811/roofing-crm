// Deterministic stand-in for the assistant when the free Workers AI allocation is used up: read the
// place, radius, year threshold and intent from the question with plain rules, then run the matching
// tool through the same client-side runner the model would have used. No model, no guessing beyond
// these rules; the UI says that this is a direct search.
import { COUNTY, type Row, type ToolResult } from "./tools";

export const ALLOWANCE_NOTE =
  "The free AI allowance for today is used up (resets 00:00 UTC). Showing a direct search instead.";
/** The Worker's /api/chat answer when the daily Workers AI allocation is used up. */
export const isAllowanceExhausted = (status: number, code: unknown) =>
  status === 503 && code === "ai_allocation_exhausted";

export type FallbackPlan = {
  tool: "find_leads" | "aged_roofs_near" | "open_roofing_permits_near" | "hail_exposed_roofs_near";
  /** Tool arguments without the place (that is resolved from `places`). */
  args: Row;
  /** Place phrases from the question, most likely first. */
  places: string[];
  /** Plain-language description of the search, e.g. "roofing permits open at least 5 years, longest-open first". */
  summary: string;
};

export const DEFAULT_RADIUS_MILES = 3;
export const LONG_OPEN_YEARS = 5;
export const DEFAULT_ROOF_YEARS = 15;

const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
};
const NUM = `(\\d+(?:\\.\\d+)?|half an?|${Object.keys(WORDS).join("|")})`;
const toNum = (s: string): number => {
  const t = s.toLowerCase();
  if (t.startsWith("half")) return 0.5;
  return WORDS[t] ?? Number(t);
};

// Words that end a place phrase ("near Allandale were hit", "of Hyde Park have an open permit").
const STOP =
  "and|or|who|whom|with|without|that|which|whose|within|where|when|were|was|is|are|have|has|had|older|newer|over|under|since|from|for|in the|during|last|past|show|list|find|built|hit|open|roofs?|homes?|houses?|permits?";
const PLACE_RE = new RegExp(`\\b(?:of|near|around|in|at)\\s+(.+?)(?=\\s+(?:${STOP})\\b|[?.,!;:()]|$)`, "gi");
const NOT_A_PLACE =
  /^(?:the\s+)?(?:last|past|least|most|area|county|travis county|my area|here|there|them|it|this|that|years?|months?)\b/i;

function placeCandidates(q: string): string[] {
  const out: string[] = [];
  const zip = /\b(7[5-9]\d{3})\b/.exec(q);
  if (zip) out.push(zip[1]);
  for (const m of q.matchAll(PLACE_RE)) {
    const p = m[1]
      .replace(/^the\s+/i, "")
      .replace(/\s+(?:area|neighborhood|tx|texas)$/i, "")
      .trim();
    if (!p || /^(?:the|a|an)$/i.test(p) || NOT_A_PLACE.test(p) || /\d/.test(p) || p.split(/\s+/).length > 4) continue;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out;
}

function radius(q: string): number {
  const m =
    new RegExp(`\\bwithin\\s+(?:a\\s+)?${NUM}\\s*-?\\s*(?:miles?|mi)\\b`, "i").exec(q) ??
    new RegExp(`\\b${NUM}\\s*-?\\s*(?:miles?|mi)\\s+(?:of|from|around|near|radius)\\b`, "i").exec(q) ??
    (/\bwithin\s+a\s+mile\b/i.test(q) ? ["", "1"] : null);
  const r = m ? toNum(m[1]) : DEFAULT_RADIUS_MILES;
  return Number.isFinite(r) ? Math.min(25, Math.max(0.1, r)) : DEFAULT_RADIUS_MILES;
}

/** "older than N years" applies to whichever of permit / roof is named closest before it. */
function thresholds(q: string, permitIntent: boolean, roofIntent: boolean) {
  let roof: number | undefined;
  let permit: number | undefined;
  for (const m of q.matchAll(new RegExp(`\\bolder than\\s+${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b`, "gi"))) {
    const before = q.slice(0, m.index).toLowerCase();
    const p = before.search(/\bpermits?\b(?!.*\bpermits?\b)/);
    const r = before.search(
      /\b(?:roofs?|homes?|houses?|properties|property|buildings?)\b(?!.*\b(?:roofs?|homes?|houses?|properties|property|buildings?)\b)/,
    );
    const n = toNum(m[1]);
    if (p > r || (p < 0 && r < 0 && permitIntent && !roofIntent)) permit ??= n;
    else roof ??= n;
  }
  const open =
    new RegExp(
      `\\bopen(?:ed)?\\s+(?:for\\s+)?(?:more than\\s+|at least\\s+|over\\s+|longer than\\s+)?${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b`,
      "i",
    ).exec(q) ??
    new RegExp(`\\b${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\s+(?:or more\\s+|or longer\\s+)?open\\b`, "i").exec(q);
  if (open) permit = toNum(open[1]);
  const aged = new RegExp(`\\b${NUM}\\s*-?\\s*\\+?\\s*years?\\s*-?\\s*old\\s+roofs?\\b`, "i").exec(q);
  if (aged && roof === undefined) roof = toNum(aged[1]);
  return { roof, permit };
}

const isoYearsAgo = (years: number, today: Date) => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - Math.round(years * 12));
  return d.toISOString().slice(0, 10);
};

export function parseQuestion(question: string, today = new Date()): FallbackPlan {
  const q = question.replace(/\s+/g, " ").trim();
  const lower = q.toLowerCase();
  const hail = /\b(hail|hailstorms?|storms?)\b/.test(lower);
  const permitIntent = /\bpermits?\b/.test(lower);
  const roofIntent =
    /\b(roofs?|homes?|houses?|properties|buildings?)\s+(?:that are\s+|which are\s+)?older than\b/.test(lower) ||
    /\b(old|older|aging|aged)\s+roofs?\b/.test(lower) ||
    /\broof age\b/.test(lower) ||
    /\byears?\s*-?\s*old\s+roofs?\b/.test(lower);
  const longOpen = /\blong[- ]?(?:open|running|standing)\b|\bstalled\b|\bnever final/.test(lower);
  const t = thresholds(q, permitIntent, roofIntent);
  const roofYears = t.roof;
  const permitYears = t.permit ?? (longOpen ? LONG_OPEN_YEARS : undefined);
  const wantsRoof = roofIntent || roofYears !== undefined;
  const residential = /\b(homes?|houses?|residential|homeowners?)\b/.test(lower);
  const r = radius(q);
  const lastYears = new RegExp(`\\b(?:in|over|during)\\s+the\\s+(?:last|past)\\s+${NUM}\\s+years?\\b`, "i").exec(q);
  const since = lastYears ? isoYearsAgo(toNum(lastYears[1]), today) : undefined;
  const places = placeCandidates(q);
  const signals = [wantsRoof, permitIntent, hail].filter(Boolean).length;

  if (signals === 1 && permitIntent)
    return {
      tool: "open_roofing_permits_near",
      args: { radius_miles: r, min_open_years: permitYears ?? 0, limit: 50 },
      places,
      summary: `open or never-finaled roofing permits${permitYears ? ` open at least ${permitYears} years` : ""}, longest-open first`,
    };
  if (hail && !permitIntent)
    return {
      tool: "hail_exposed_roofs_near",
      args: {
        radius_miles: r,
        ...(since ? { since } : {}),
        ...(roofYears !== undefined ? { older_than_years: roofYears } : {}),
        limit: 50,
      },
      places,
      summary: `roofs hit by hail of 1.75 in or more since ${since ?? "3 years ago"}${roofYears !== undefined ? `, roofs older than ${roofYears} years` : ""}`,
    };
  if (signals === 1 && wantsRoof)
    return {
      tool: "aged_roofs_near",
      args: {
        radius_miles: r,
        older_than_years: roofYears ?? DEFAULT_ROOF_YEARS,
        ...(residential ? { residential_only: true } : {}),
        limit: 50,
      },
      places,
      summary: `${residential ? "homes" : "properties"} with roofs older than ${roofYears ?? DEFAULT_ROOF_YEARS} years`,
    };
  // Combined criteria, or nothing recognizable: the main lead search.
  const none = signals === 0;
  const roofCut = wantsRoof || none ? (roofYears ?? DEFAULT_ROOF_YEARS) : undefined;
  const permitCut = permitIntent || none ? (permitYears ?? 0) : undefined;
  const parts = [
    roofCut !== undefined ? `roof older than ${roofCut} years` : "",
    permitCut !== undefined ? `an open roofing permit${permitCut ? ` (at least ${permitCut} years)` : ""}` : "",
    hail ? "severe hail since the roof" : "",
  ].filter(Boolean);
  return {
    tool: "find_leads",
    args: {
      radius_miles: r,
      ...(roofCut !== undefined ? { roof_older_than_years: roofCut } : {}),
      ...(permitCut !== undefined ? { open_permit_min_years: permitCut } : {}),
      ...(hail ? { hail_since_roof: true } : {}),
      ...(residential ? { residential_only: true } : {}),
      match: "any",
      limit: 50,
    },
    places,
    summary: `${residential ? "homes" : "properties"} with ${parts.join(" or ")}, ranked by lead score`,
  };
}

export type FallbackResult = { plan: FallbackPlan; result: ToolResult; place: string; placeNote?: string };
const NO_PLACE = /no Travis County place matches/;

/** Run the plan: the first place phrase the gazetteer knows, else the default center (said so). */
export async function runFallback(
  question: string,
  exec: (tool: string, args: Row) => Promise<ToolResult>,
  today = new Date(),
): Promise<FallbackResult> {
  const plan = parseQuestion(question, today);
  for (const place of plan.places) {
    try {
      const result = await exec(plan.tool, { ...plan.args, place });
      return { plan, result, place: String(result.resolvedPlace?.name ?? place) };
    } catch (e) {
      if (!NO_PLACE.test(String((e as Error).message ?? e))) throw e;
    }
  }
  const pin = COUNTY.defaultPin;
  const result = await exec(plan.tool, { ...plan.args, latitude: pin.lat, longitude: pin.lon });
  return {
    plan,
    result,
    place: pin.label,
    placeNote: plan.places.length
      ? `No Travis County place matches "${plan.places[0]}"; searched around ${pin.label}.`
      : `No place named; searched around ${pin.label}.`,
  };
}
