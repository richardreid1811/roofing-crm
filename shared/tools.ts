// Roofing-lead query tools over the published Travis County snapshot (DuckDB SQL).
// One definition per tool: a Zod schema (the agent's tool contract, also used to validate every call)
// and SQL builders that run in DuckDB-WASM in the browser. Tables come from the pipeline's data
// contract: leads, roofing_permits, contractors, hail_events, permit_embeddings, plus `places`
// (built at load time by PLACES_SQL). SQL builders interpolate only schema-validated values.
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Input coercion. Llama sends numbers and booleans as strings and empty strings for "not set".

const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const optNumber = (min: number, max: number) => z.preprocess(blank, z.coerce.number().min(min).max(max).optional());
const numberWithDefault = (min: number, max: number, dflt: number) =>
  z.preprocess(blank, z.coerce.number().min(min).max(max).default(dflt));
const optBool = () =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : blank(v)), z.boolean().optional());
const isoDate = () =>
  z.preprocess(
    blank,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
  );

// Travis County area. Coordinates outside it are rejected, never clamped (clamping would silently
// search a different place).
export const COUNTY = {
  name: "Travis County, TX",
  center: { lat: 30.3, lon: -97.75 },
  defaultPin: { lat: 30.2672, lon: -97.7431, label: "Downtown Austin" },
  bounds: { minLat: 29.9, maxLat: 30.7, minLon: -98.3, maxLon: -97.3 },
};
export const inCounty = (lat: number, lon: number) =>
  lat >= COUNTY.bounds.minLat &&
  lat <= COUNTY.bounds.maxLat &&
  lon >= COUNTY.bounds.minLon &&
  lon <= COUNTY.bounds.maxLon;

const pointShape = {
  place: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Preferred: a Travis County city, ZIP code or Austin neighborhood (e.g. 'Pflugerville', '78704', 'Hyde Park'). Use this whenever the user names a place.",
    ),
  latitude: optNumber(-90, 90).describe("Center latitude, only for an exact map pin."),
  longitude: optNumber(-180, 180).describe("Center longitude, only for an exact map pin."),
  radius_miles: numberWithDefault(0.1, 25, 5).describe("Search radius in miles (default 5, max 25)."),
  limit: numberWithDefault(1, 200, 25).describe("Maximum rows (default 25, max 200)."),
};

type Point = { lat: number; lon: number; r: number };
function point(a: { latitude?: number; longitude?: number; radius_miles: number }): Point {
  if (a.latitude === undefined || a.longitude === undefined)
    throw new Error("a place or a latitude/longitude is required");
  if (!inCounty(a.latitude, a.longitude))
    throw new Error(`${a.latitude}, ${a.longitude} is outside the Travis County area`);
  return { lat: a.latitude, lon: a.longitude, r: a.radius_miles };
}

const str = (v: string, max = 120) => v.slice(0, max).replaceAll("'", "''");
const lim = (n: number) => Math.trunc(n);

// Great-circle distance in miles between (latCol, lonCol) and a validated point.
export const miles = (lat: number | string, lon: number | string, latCol = "latitude", lonCol = "longitude") =>
  `3958.8 * 2 * asin(sqrt(pow(sin(radians(${latCol} - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(${latCol})) * pow(sin(radians(${lonCol} - ${lon}) / 2), 2)))`;
// Cheap bounding box first, then exact distance.
const bbox = (p: Point, latCol = "latitude", lonCol = "longitude", extra = 0) => {
  const dLat = (p.r + extra) / 69.0;
  const dLon = (p.r + extra) / (69.17 * Math.cos((p.lat * Math.PI) / 180));
  return `${latCol} between ${p.lat - dLat} and ${p.lat + dLat} and ${lonCol} between ${p.lon - dLon} and ${p.lon + dLon}`;
};
const within = (p: Point, latCol = "latitude", lonCol = "longitude") =>
  `${bbox(p, latCol, lonCol)} and ${miles(p.lat, p.lon, latCol, lonCol)} <= ${p.r}`;

// Ownership tenure in whole years as of today.
const tenure = (col = "deed_date") => `cast(floor(date_diff('day', ${col}, current_date) / 365.2425) as integer)`;
const CONFIDENCE_ORDER = `case roof_age_confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end`;
const RESIDENTIAL = `(imprv_state_cd like 'A%' or imprv_state_cd like 'B%' or imprv_state_cd like 'E%')`;
// Roofing permits that represent roof work (not solar or electrical work on roofs).
const ROOF_WORK = `roofing_work in ('roof_replacement', 'roof_repair')`;
const OPEN_BUCKETS = ["open", "expired_unfinaled"] as const;

// ---------------------------------------------------------------------------------------------
// Combined lead finder: radius + any/all of roof age, open roofing permit, hail since roof.

export const findLeadsSchema = z.object({
  ...pointShape,
  roof_older_than_years: optNumber(0, 150).describe(
    "Include roofs strictly older than this many years (estimated roof age). Omit to not use roof age.",
  ),
  open_permit_min_years: optNumber(0, 100).describe(
    "Include properties with an open or never-finaled roofing permit open at least this many years (0 = any open permit). Omit to not use permits.",
  ),
  permit_statuses: z
    .array(z.enum(OPEN_BUCKETS))
    .min(1)
    .optional()
    .describe("Permit statuses that count as open: 'open', 'expired_unfinaled' (default both)."),
  hail_since_roof: optBool().describe(
    "Include properties with severe hail (1.75 in or larger within 1 mile) since the roof year.",
  ),
  match: z
    .enum(["any", "all"])
    .default("any")
    .describe("'any' = a property matches any enabled criterion; 'all' = every enabled criterion."),
  residential_only: optBool().describe("Only residential properties (TCAD state codes A, B, E)."),
});
export type FindLeadsArgs = z.infer<typeof findLeadsSchema>;

function findLeadsParts(a: FindLeadsArgs) {
  const p = point(a);
  const statuses = a.permit_statuses ?? [...OPEN_BUCKETS];
  const conds: string[] = [];
  if (a.roof_older_than_years !== undefined) conds.push(`l.roof_age_years > ${a.roof_older_than_years}`);
  if (a.open_permit_min_years !== undefined)
    conds.push(`perm.oldest_open_days >= ${Math.round(a.open_permit_min_years * 365.25)}`);
  if (a.hail_since_roof) conds.push(`l.severe_hail_reports_since_roof > 0`);
  if (!conds.length) throw new Error("enable at least one lead criterion (roof age, open permit or hail)");
  const where = conds.map((c) => `coalesce(${c}, false)`).join(a.match === "all" ? " and " : " or ");
  const ageCut = a.roof_older_than_years ?? 1e9;
  const permitCut = a.open_permit_min_years === undefined ? 1e9 : Math.round(a.open_permit_min_years * 365.25);
  const ctes = `
    with perm as (
      select prop_id,
             count(*) filter (status_bucket = 'open') as open_permits,
             count(*) filter (status_bucket = 'expired_unfinaled') as expired_unfinaled_permits,
             min(opened_date) as oldest_open_date,
             max(date_diff('day', opened_date, current_date)) as oldest_open_days,
             arg_min(permit_number, opened_date::varchar || permit_number) as oldest_open_permit,
             arg_min(status, opened_date::varchar || permit_number) as oldest_open_status,
             arg_min(contractor_company_name, opened_date::varchar || permit_number) as oldest_open_contractor,
             arg_min(contractor_key, opened_date::varchar || permit_number) as oldest_open_contractor_key
      from roofing_permits
      where ${ROOF_WORK} and status_bucket in (${statuses.map((s) => `'${s}'`).join(", ")}) and prop_id is not null
      group by prop_id
    ),
    base as (
      -- leads carries its own oldest_open_* columns (all open statuses); use the status-filtered ones from perm.
      select l.* exclude (oldest_open_permit, oldest_open_contractor, oldest_open_date), perm.open_permits, perm.expired_unfinaled_permits, perm.oldest_open_date, perm.oldest_open_days,
             perm.oldest_open_permit, perm.oldest_open_status, perm.oldest_open_contractor, perm.oldest_open_contractor_key,
             coalesce(l.roof_age_years > ${ageCut}, false) as signal_aged_roof,
             coalesce(perm.oldest_open_days >= ${permitCut}, false) as signal_open_permit,
             ${a.hail_since_roof ? "coalesce(l.severe_hail_reports_since_roof > 0, false)" : "false"} as signal_hail
      from leads l left join perm using (prop_id)
      where ${within(p, "l.latitude", "l.longitude")} ${a.residential_only ? `and ${RESIDENTIAL.replaceAll("imprv", "l.imprv")}` : ""}
        and (${where})
    )`;
  return { p, ctes };
}

// Lead score (shown in the UI): roof age weighted by evidence confidence, plus long-open permits,
// plus severe hail since the roof. Transparent on purpose so reps can explain a ranking.
export const LEAD_SCORE_SQL = `round(
  case when signal_aged_roof then least(roof_age_years, 40) * case roof_age_confidence when 'high' then 1 when 'medium' then 0.9 when 'low' then 0.7 else 0.5 end else 0 end
  + case when signal_open_permit then 20 + 3 * least(oldest_open_days / 365.25, 10) else 0 end
  + case when signal_hail then 10 * least(severe_hail_reports_since_roof, 3) else 0 end)`;
export const LEAD_SCORE_EXPLAINED =
  "Score = roof age (capped at 40) × evidence confidence (high 1, medium 0.9, low 0.7, very low 0.5) when the roof is over the threshold, + 20 + 3 per year open (capped at 10 years) for an open roofing permit, + 10 per severe hail report since the roof (up to 3).";

export function findLeadsSql(a: FindLeadsArgs): string {
  const { p, ctes } = findLeadsParts(a);
  return `${ctes}
    select b.prop_id, b.situs_address, b.situs_zip, b.jurisdiction, round(${miles(p.lat, p.lon, "b.latitude", "b.longitude")}, 2) as distance_miles,
           ${LEAD_SCORE_SQL.replaceAll("\n", " ")} as lead_score,
           b.signal_aged_roof, b.signal_open_permit, b.signal_hail,
           b.roof_age_years, b.roof_year, b.roof_age_basis, b.roof_age_confidence, b.roof_covering, b.year_built,
           coalesce(b.open_permits, 0) as open_permits, coalesce(b.expired_unfinaled_permits, 0) as expired_unfinaled_permits,
           b.oldest_open_permit, b.oldest_open_status, b.oldest_open_date, round(b.oldest_open_days / 365.25, 1) as oldest_open_years,
           b.oldest_open_contractor, b.oldest_open_contractor_key as contractor_key, c.legal_name as contractor_legal_name, c.identity_status as contractor_identity,
           c.bbb_rating, c.bbb_status,
           b.severe_hail_reports_since_roof, b.max_hail_inches_since_roof, b.last_severe_hail_date_since_roof,
           b.owner_name, b.owner_mail_region, b.permit_history_coverage, b.imprv_state_cd,
           b.latitude, b.longitude, b.source_detail_url
    from base b left join contractors c on c.contractor_key = b.oldest_open_contractor_key
    order by lead_score desc, distance_miles, b.prop_id
    limit ${lim(a.limit)}`;
}

export function findLeadsCountSql(a: FindLeadsArgs): string {
  const { ctes } = findLeadsParts(a);
  return `${ctes}
    select count(*) as matches, count(*) filter (signal_aged_roof) as aged_roof,
           count(*) filter (signal_open_permit) as open_permit, count(*) filter (signal_hail) as hail
    from base`;
}

// ---------------------------------------------------------------------------------------------
// Single-signal tools (agent).

export const agedRoofsSchema = z.object({
  ...pointShape,
  older_than_years: numberWithDefault(0, 150, 15).describe("Roofs strictly older than this (default 15)."),
  residential_only: optBool().describe("Only residential properties. Default false."),
});
const agedWhere = (a: z.infer<typeof agedRoofsSchema>, p: Point) =>
  `${within(p)} and roof_age_years > ${a.older_than_years} ${a.residential_only ? `and ${RESIDENTIAL}` : ""}`;

export const openPermitsSchema = z.object({
  ...pointShape,
  min_open_years: numberWithDefault(0, 100, 0).describe("Only permits open at least this many years (default 0)."),
  issued_since: isoDate().describe("Optional ISO date; only permits opened on or after it."),
});
const openWhere = (a: z.infer<typeof openPermitsSchema>, p: Point, alias = "p.") =>
  `${alias}${ROOF_WORK} and ${alias}status_bucket in ('open', 'expired_unfinaled')
   and ${within(p, `${alias}latitude`, `${alias}longitude`)}
   and date_diff('day', ${alias}opened_date, current_date) >= ${Math.round(a.min_open_years * 365.25)}
   ${a.issued_since ? `and ${alias}opened_date >= date '${a.issued_since}'` : ""}`;

export const hailSchema = z.object({
  ...pointShape,
  since: isoDate().describe("Only hail on or after this ISO date (default: 3 years ago)."),
  min_hail_inches: numberWithDefault(0.75, 6, 1.75).describe("Minimum hail size in inches (default 1.75)."),
  event_radius_miles: numberWithDefault(0.25, 3, 1).describe(
    "Distance from a hail report to the property (default 1).",
  ),
  older_than_years: optNumber(0, 150).describe("Optional: only roofs strictly older than this."),
});
function hailSql(a: z.infer<typeof hailSchema>, countOnly: boolean) {
  const p = point(a);
  const er = a.event_radius_miles;
  const dLat = er / 69.0;
  const dLon = er / (69.17 * Math.cos((p.lat * Math.PI) / 180));
  const body = `
    with p as (
      select prop_id, situs_address, jurisdiction, latitude, longitude, roof_year, roof_age_years, roof_age_basis,
             roof_age_confidence, roof_covering, open_roofing_permits, owner_name, source_detail_url
      from leads
      where ${within(p)} and roof_year is not null
        ${a.older_than_years === undefined ? "" : `and roof_age_years > ${a.older_than_years}`}
    ),
    ev as (
      select event_date, latitude as elat, longitude as elon, hail_inches from hail_events
      where hail_inches >= ${a.min_hail_inches}
        and event_date >= ${a.since ? `date '${a.since}'` : "current_date - interval 3 year"}
        and ${bbox(p, "latitude", "longitude", er)}
    ),
    hits as (
      select p.prop_id, count(*) as hail_reports, max(ev.hail_inches) as max_hail_inches, max(ev.event_date) as last_hail_date
      from p join ev on ev.elat between p.latitude - ${dLat} and p.latitude + ${dLat}
                    and ev.elon between p.longitude - ${dLon} and p.longitude + ${dLon}
      where year(ev.event_date) >= p.roof_year and ${miles("p.latitude", "p.longitude", "ev.elat", "ev.elon")} <= ${er}
      group by p.prop_id
    )`;
  if (countOnly) return `${body} select count(*) as matches from hits`;
  return `${body}
    select p.prop_id, p.situs_address, p.jurisdiction, round(${miles(p.lat, p.lon, "p.latitude", "p.longitude")}, 2) as distance_miles,
           h.hail_reports, h.max_hail_inches, h.last_hail_date, p.roof_age_years, p.roof_year, p.roof_age_basis,
           p.roof_age_confidence, p.roof_covering, p.open_roofing_permits, p.owner_name, p.latitude, p.longitude, p.source_detail_url
    from hits h join p using (prop_id)
    order by h.hail_reports desc, h.max_hail_inches desc, h.last_hail_date desc, p.prop_id
    limit ${lim(a.limit)}`;
}

export const semanticSchema = z.object({
  query: z.string().min(2).max(200).describe("What the permit work is about, in plain language."),
  place: pointShape.place,
  latitude: pointShape.latitude,
  longitude: pointShape.longitude,
  radius_miles: numberWithDefault(0.1, 25, 5).describe("Only with a place or coordinates (default 5)."),
  open_only: optBool().describe("Only permits still open or expired without a final inspection."),
  limit: pointShape.limit,
});
export type SemanticArgs = z.infer<typeof semanticSchema> & { _qvec?: number[] };
export const EMBED_DIMS = 384;

export const propertySchema = z.object({
  prop_id: z
    .string()
    .regex(/^\d{1,12}$/)
    .describe("TCAD property id (digits)."),
});
export const placeSchema = z.object({ name: z.string().min(1).max(80) });

// ---------------------------------------------------------------------------------------------
// Tool registry.

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  sql: (a: z.infer<S>) => string;
  countSql?: (a: z.infer<S>) => string;
  needsEmbedding?: boolean;
  /** true when a `place` argument should be resolved to latitude/longitude before SQL is built */
  usesPoint: boolean;
};
const def = <S extends z.ZodType>(t: ToolDef<S>): ToolDef => t as unknown as ToolDef;

const BBB_NOTE =
  "BBB ratings are not in the dataset (BBB blocks automated access and has no public API); rows carry bbb_lookup_url to check BBB directly.";

export const tools: ToolDef[] = [
  def({
    name: "find_leads",
    description: `Main CRM lead search: properties within a radius matching any (or all) of: roof older than N years, an open or never-finaled roofing permit open at least N years, severe hail since the roof year. Ranked by lead score. Returns roof-age evidence, the oldest open permit with status, years open and contractor, hail, owner and source link. ${BBB_NOTE}`,
    schema: findLeadsSchema,
    sql: findLeadsSql,
    countSql: findLeadsCountSql,
    usesPoint: true,
  }),
  def({
    name: "aged_roofs_near",
    description:
      "Properties within a radius whose estimated roof is strictly older than older_than_years (default 15). Ranked permit-verified first. roof_age_confidence: high = finaled re-roof permit, medium = unfinaled re-roof permit, low = year built, very_low = year built over 50 years ago.",
    schema: agedRoofsSchema,
    sql: (a) => {
      const p = point(a);
      return `
        select prop_id, situs_address, jurisdiction, round(${miles(p.lat, p.lon)}, 2) as distance_miles,
               roof_age_years, roof_year, roof_age_basis, roof_age_confidence, roof_covering, year_built,
               open_roofing_permits, oldest_open_permit, oldest_open_contractor, severe_hail_reports_since_roof,
               owner_name, owner_mail_region, permit_history_coverage, latitude, longitude, source_detail_url
        from leads where ${agedWhere(a, p)}
        order by ${CONFIDENCE_ORDER}, roof_age_years desc, distance_miles, prop_id
        limit ${lim(a.limit)}`;
    },
    countSql: (a) => {
      const p = point(a);
      return `select count(*) as matches, count(*) filter (roof_age_confidence = 'high') as permit_verified from leads where ${agedWhere(a, p)}`;
    },
    usesPoint: true,
  }),
  def({
    name: "open_roofing_permits_near",
    description: `Roofing permits (re-roof / roof repair) within a radius that are still open or expired without a final inspection, longest-open first, with status, years open, contractor, Texas registry identity and the property's estimated roof age (roof_age_years, roof_year, roof_age_basis, roof_age_confidence, as in aged_roofs_near). min_open_years filters long-open permits. ${BBB_NOTE}`,
    schema: openPermitsSchema,
    sql: (a) => {
      const p = point(a);
      return `
        select p.permit_number, p.status, p.status_bucket, p.roofing_work, p.opened_date, p.expires_date,
               date_diff('day', p.opened_date, current_date) as open_days,
               round(date_diff('day', p.opened_date, current_date) / 365.25, 1) as open_years,
               p.address, p.prop_id, round(${miles(p.lat, p.lon, "p.latitude", "p.longitude")}, 2) as distance_miles,
               p.contractor_company_name, p.contractor_key, p.contractor_phone, c.legal_name as contractor_legal_name,
               c.identity_status as contractor_identity, c.bbb_rating, c.bbb_status, left(p.description, 160) as description,
               l.roof_age_years, l.roof_year, l.roof_age_basis, l.roof_age_confidence, l.roof_covering,
               l.permit_history_coverage, p.latitude, p.longitude, p.source_detail_url
        from roofing_permits p left join contractors c using (contractor_key)
        left join leads l on l.prop_id = p.prop_id
        where ${openWhere(a, p)}
        order by p.opened_date, p.permit_number
        limit ${lim(a.limit)}`;
    },
    countSql: (a) => {
      const p = point(a);
      return `select count(*) as matches, count(contractor_company_name) as with_contractor from roofing_permits where ${openWhere(a, p, "")}`;
    },
    usesPoint: true,
  }),
  def({
    name: "hail_exposed_roofs_near",
    description:
      "Properties within a radius whose current roof was hit by hail: NOAA Storm Events reports of at least min_hail_inches (default 1.75) within event_radius_miles (default 1), on or after since (default 3 years ago) and not before the roof year. A lead signal, not evidence of damage.",
    schema: hailSchema,
    sql: (a) => hailSql(a, false),
    countSql: (a) => hailSql(a, true),
    usesPoint: true,
  }),
  def({
    name: "semantic_search_permits",
    description:
      "Meaning-based search over roofing permit descriptions (e.g. 'hail damage repair', 'metal roof on commercial building'), even when the wording differs. Optionally within a place/radius and only open permits. Returns similarity scores.",
    schema: semanticSchema,
    needsEmbedding: true,
    usesPoint: true,
    sql: (a: SemanticArgs) => {
      if (!Array.isArray(a._qvec) || a._qvec.length !== EMBED_DIMS) throw new Error("query embedding missing");
      const vec = `[${a._qvec.map((v) => Number(v).toFixed(6)).join(",")}]::FLOAT[${EMBED_DIMS}]`;
      const p = a.latitude !== undefined && a.longitude !== undefined ? point(a) : null;
      return `
        with q as (select ${vec} as v)
        select p.permit_number, p.status, p.status_bucket, p.roofing_work, p.opened_date,
               case when p.status_bucket in ('open', 'expired_unfinaled') then round(date_diff('day', p.opened_date, current_date) / 365.25, 1) end as open_years,
               p.address, p.prop_id, left(p.description, 200) as description, p.contractor_company_name, p.contractor_key,
               c.legal_name as contractor_legal_name, c.identity_status as contractor_identity, c.bbb_rating,
               round(array_cosine_similarity(e.embedding::FLOAT[${EMBED_DIMS}], q.v)::DOUBLE, 3) as similarity,
               ${p ? `round(${miles(p.lat, p.lon, "p.latitude", "p.longitude")}, 2) as distance_miles,` : ""}
               p.latitude, p.longitude, p.source_detail_url
        from permit_embeddings e join roofing_permits p using (permit_key)
        left join contractors c using (contractor_key) cross join q
        where true ${a.open_only ? "and p.status_bucket in ('open', 'expired_unfinaled')" : ""}
          ${p ? `and ${within(p, "p.latitude", "p.longitude")}` : ""}
        order by array_cosine_similarity(e.embedding::FLOAT[${EMBED_DIMS}], q.v) desc, p.permit_key
        limit ${lim(a.limit)}`;
    },
  }),
  def({
    name: "property_detail",
    description:
      "Full record for one TCAD property id: owner, deed, roof-age evidence, hail, and every roofing permit on the parcel with contractor.",
    schema: propertySchema,
    sql: (a) => propertySql(a.prop_id),
    usesPoint: false,
  }),
  def({
    name: "resolve_place",
    description: "Resolve a Travis County place (city, ZIP or Austin neighborhood) to a center point.",
    schema: placeSchema,
    sql: (a) => placeSql(a.name),
    usesPoint: false,
  }),
];
export const toolByName: Record<string, ToolDef> = Object.fromEntries(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------------------------
// Property drawer queries and the gazetteer.

const propId = (id: string) => id.replace(/[^0-9]/g, "").slice(0, 12);
export const propertySql = (id: string) =>
  `select *, ${tenure()} as years_since_deed from leads where prop_id = '${propId(id)}'`;
export const propertyPermitsSql = (id: string) => `
  select p.permit_number, p.permit_type_desc, p.work_class, p.roofing_work, p.status, p.status_bucket,
         p.applied_date, p.issued_date, p.opened_date, p.expires_date, p.completed_date,
         case when p.status_bucket in ('open', 'expired_unfinaled') then date_diff('day', p.opened_date, current_date)
              else date_diff('day', p.opened_date, coalesce(p.completed_date, p.closed_date)) end as duration_days,
         p.status_bucket in ('open', 'expired_unfinaled') as is_open,
         left(p.description, 300) as description, p.job_valuation,
         p.contractor_company_name, p.contractor_key, p.contractor_full_name, p.contractor_phone, p.contractor_city,
         c.legal_name as contractor_legal_name, c.identity_status as contractor_identity, c.taxpayer_number,
         c.roofing_permit_count as contractor_roofing_permits, c.bbb_rating, c.bbb_status, c.tdlr_licenses,
         p.source_detail_url
  from roofing_permits p left join contractors c using (contractor_key)
  where p.prop_id = '${propId(id)}'
  order by p.opened_date desc, p.permit_number`;

export const placeSql = (name: string) => `
  select name, kind, latitude, longitude, parcels from places
  where upper(name) = upper('${str(name)}') or upper(name) like upper('%${str(name)}%')
  order by (upper(name) = upper('${str(name)}')) desc, parcels desc
  limit 5`;

// Well-known Austin-area places that are not municipalities or ZIPs (approximate centers).
const LANDMARKS: [string, number, number][] = [
  ["Downtown Austin", 30.2672, -97.7431],
  ["UT Austin campus", 30.2849, -97.7341],
  ["Hyde Park", 30.3062, -97.728],
  ["Zilker", 30.2669, -97.7729],
  ["South Congress", 30.2475, -97.75],
  ["East Austin", 30.2633, -97.72],
  ["Mueller", 30.2983, -97.7056],
  ["Barton Hills", 30.2547, -97.7849],
  ["Tarrytown", 30.2955, -97.768],
  ["Clarksville", 30.2827, -97.759],
  ["The Domain", 30.4021, -97.7253],
  ["Circle C Ranch", 30.192, -97.8823],
  ["Travis Heights", 30.249, -97.743],
  ["Allandale", 30.3366, -97.7462],
  ["Crestview", 30.3456, -97.727],
  ["Windsor Park", 30.317, -97.69],
  ["Bouldin Creek", 30.255, -97.756],
  ["Montopolis", 30.234, -97.697],
  ["Del Valle", 30.188, -97.638],
  ["Steiner Ranch", 30.3866, -97.8853],
  ["Jollyville", 30.4436, -97.7714],
];
// Gazetteer from the data itself (municipality and ZIP centroids) plus the landmarks. Needs `leads`.
export const PLACES_SQL = `
  create or replace table places as
  select replace(replace(jurisdiction, 'CITY OF ', ''), 'VILLAGE OF ', '') as name, 'municipality' as kind,
         avg(latitude) as latitude, avg(longitude) as longitude, count(*) as parcels
  from leads where latitude is not null group by 1
  union all
  select situs_zip, 'zip', avg(latitude), avg(longitude), count(*)
  from leads where latitude is not null and situs_zip is not null group by 1 having count(*) >= 50
  union all
  select * from (values ${LANDMARKS.map(([n, la, lo]) => `('${n}', 'neighborhood (approximate)', ${la}, ${lo}, 0)`).join(", ")})`;

// ---------------------------------------------------------------------------------------------
// Running a tool: validate, resolve place, build SQL. `run` executes SQL and returns rows.

export type Row = Record<string, unknown>;
export type Run = (sql: string) => Promise<Row[]>;
export type ToolResult = { rows: Row[]; count?: Row; sql: string; args: Row; resolvedPlace?: Row };

// "near Hyde Park", "around 78704", "city of Lakeway" -> drop filler words first; "north Austin" ->
// drop directions only if that still finds nothing (so "Downtown Austin" stays a neighborhood).
const FILLER = /\b(near|around|in|city of|village of|the area of)\b/gi;
const DIRECTIONS = /\b(downtown|central|north|south|east|west|northwest|northeast|southwest|southeast)\b/gi;

export async function resolvePlace(name: string, run: Run): Promise<Row | undefined> {
  const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
  const candidates = [name, tidy(name.replace(FILLER, "")), tidy(name.replace(FILLER, "").replace(DIRECTIONS, ""))];
  for (const c of [...new Set(candidates)].filter(Boolean)) {
    const [hit] = await run(placeSql(c));
    if (hit) return hit;
  }
  return undefined;
}

export async function runTool(
  name: string,
  rawArgs: unknown,
  run: Run,
  embedQuery?: (text: string) => Promise<ArrayLike<number>>,
): Promise<ToolResult> {
  const tool = toolByName[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new Error(`invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
  const args = { ...(parsed.data as Row) };
  let resolvedPlace: Row | undefined;
  if (tool.usesPoint && typeof args.place === "string" && args.place.trim()) {
    const hit = await resolvePlace(args.place, run);
    if (!hit) throw new Error(`no Travis County place matches "${args.place}"`);
    args.latitude = Number(hit.latitude);
    args.longitude = Number(hit.longitude);
    resolvedPlace = { name: hit.name, kind: hit.kind, latitude: args.latitude, longitude: args.longitude };
  }
  if (tool.needsEmbedding) {
    if (!embedQuery) throw new Error("semantic search needs an embedder");
    args._qvec = Array.from(await embedQuery(String(args.query)));
  }
  const sql = tool.sql(args);
  const rows = withLookupLinks(await run(sql));
  const count = tool.countSql ? (await run(tool.countSql(args)))[0] : undefined;
  delete args._qvec;
  return { rows, count, sql, args, resolvedPlace };
}

/**
 * Viewer-initiated BBB lookup: BBB blocks automated access and has no public API, so the data has
 * no ratings. Rows naming a contractor carry a link to BBB's own search for that name.
 */
export const bbbLookupUrl = (name: unknown, city = "Austin, TX") =>
  name
    ? `https://www.bbb.org/search?find_country=USA&find_text=${encodeURIComponent(String(name))}&find_loc=${encodeURIComponent(city)}`
    : null;
export const withLookupLinks = (rows: Row[]) =>
  rows.map((r) => {
    const name = r.contractor_company_name ?? r.oldest_open_contractor;
    return name ? { ...r, bbb_lookup_url: bbbLookupUrl(name) } : r;
  });
