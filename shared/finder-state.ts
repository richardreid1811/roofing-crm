// Lead-finder state (pin, radius, criteria, thresholds, sort, match mode). It survives in-app
// navigation and reloads in sessionStorage; anything stored is re-validated before use.
import type { SortKey } from "./display";
import { COUNTY, inCounty } from "./tools";

export type Center = { lat: number; lon: number; label: string };
export type Filters = {
  radius: number;
  ageOn: boolean;
  age: number;
  /** Weakest roof-age evidence that still counts as an aged roof. */
  minConfidence: "very_low" | "low" | "medium";
  permitOn: boolean;
  permitYears: number;
  statusOpen: boolean;
  statusExpired: boolean;
  hailOn: boolean;
  match: "any" | "all";
  residential: boolean;
};
export type FinderState = { center: Center; filters: Filters; sort: SortKey; place: string };

export const DEFAULT_FILTERS: Filters = {
  radius: 1.5,
  ageOn: true,
  age: 15,
  minConfidence: "very_low",
  permitOn: true,
  permitYears: 0,
  statusOpen: true,
  statusExpired: true,
  hailOn: false,
  match: "any",
  residential: false,
};
export const DEFAULT_FINDER_STATE: FinderState = {
  center: { ...COUNTY.defaultPin },
  filters: DEFAULT_FILTERS,
  sort: "lead_score",
  place: "",
};
const SORTS: SortKey[] = ["lead_score", "roof_age_years", "oldest_open_years", "distance_miles"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const numIn = (v: unknown, min: number, max: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T =>
  options.includes(v as T) ? (v as T) : d;

/** Parse stored state; invalid or missing fields fall back to the defaults, a pin outside the county is dropped. */
export function parseFinderState(json: string | null | undefined): FinderState {
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    raw = null;
  }
  if (!isObj(raw)) return DEFAULT_FINDER_STATE;
  const d = DEFAULT_FILTERS;
  const f = isObj(raw.filters) ? raw.filters : {};
  const c = isObj(raw.center) ? raw.center : {};
  const lat = Number(c.lat);
  const lon = Number(c.lon);
  const center =
    typeof c.lat === "number" && typeof c.lon === "number" && inCounty(lat, lon)
      ? { lat, lon, label: typeof c.label === "string" ? c.label.slice(0, 80) : "Dropped pin" }
      : DEFAULT_FINDER_STATE.center;
  return {
    center,
    filters: {
      radius: numIn(f.radius, 0.25, 10, d.radius),
      ageOn: bool(f.ageOn, d.ageOn),
      age: numIn(f.age, 0, 100, d.age),
      minConfidence: oneOf(f.minConfidence, ["very_low", "low", "medium"] as const, d.minConfidence),
      permitOn: bool(f.permitOn, d.permitOn),
      permitYears: numIn(f.permitYears, 0, 40, d.permitYears),
      statusOpen: bool(f.statusOpen, d.statusOpen),
      statusExpired: bool(f.statusExpired, d.statusExpired),
      hailOn: bool(f.hailOn, d.hailOn),
      match: oneOf(f.match, ["any", "all"] as const, d.match),
      residential: bool(f.residential, d.residential),
    },
    sort: oneOf(raw.sort, SORTS, "lead_score"),
    place: typeof raw.place === "string" ? raw.place.slice(0, 80) : "",
  };
}

export const isDefaultView = (s: FinderState) =>
  s.center.lat === COUNTY.defaultPin.lat &&
  s.center.lon === COUNTY.defaultPin.lon &&
  s.filters.radius === DEFAULT_FILTERS.radius;
