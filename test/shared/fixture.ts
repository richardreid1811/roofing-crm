// A tiny Travis County snapshot in DuckDB with the published column names, for testing tool SQL.
import { DuckDBInstance } from "@duckdb/node-api";
import { PLACES_SQL, type Row, type Run } from "../../shared/tools";

export const CENTER = { lat: 30.2672, lon: -97.7431 };
const NORTH_HALF_MILE = 30.2672 + 0.5 / 69;
const NORTH_ONE_MILE = 30.2672 + 1 / 69;

const DDL = `
create table leads (
  prop_id varchar, situs_address varchar, situs_zip varchar, jurisdiction varchar, latitude double, longitude double,
  owner_name varchar, mail_city varchar, mail_state varchar, mail_zip varchar, owner_mail_region varchar,
  owner_occupied_homestead boolean, owner_property_count bigint, deed_date date, market_val bigint,
  roof_age_years integer, roof_year bigint, roof_age_basis varchar, roof_age_confidence varchar, roof_covering varchar,
  roof_style varchar, year_built integer, permit_history_coverage varchar, imprv_state_cd varchar,
  open_roofing_permits bigint, oldest_open_date date, oldest_open_permit varchar, oldest_open_contractor varchar,
  severe_hail_reports_since_roof bigint, max_hail_inches_since_roof double, last_severe_hail_date_since_roof date,
  source_detail_url varchar);
create table roofing_permits (
  permit_key varchar, permit_number varchar, permit_type_desc varchar, work_class varchar, status varchar, status_bucket varchar,
  roofing_work varchar, applied_date date, issued_date date, opened_date date, expires_date date, completed_date date,
  closed_date date, prop_id varchar, latitude double, longitude double, address varchar, description varchar,
  job_valuation double, contractor_company_name varchar, contractor_full_name varchar, contractor_phone varchar,
  contractor_city varchar, contractor_key varchar, source_detail_url varchar);
create table contractors (
  contractor_key varchar, legal_name varchar, identity_status varchar, bbb_rating varchar, bbb_status varchar,
  taxpayer_number varchar, roofing_permit_count bigint, tdlr_licenses varchar);
create table hail_events (event_id varchar, event_date date, latitude double, longitude double, hail_inches double);
`;

// leads: (id, address, lat, roof_age, confidence, hail_reports, state code)
const LEADS: [string, string, number, number, string, number, string][] = [
  ["1", "100 AGED ST", CENTER.lat, 30, "low", 0, "A1"], // aged roof only
  ["2", "200 PERMIT ST", NORTH_HALF_MILE, 10, "high", 0, "A1"], // open permit (7 years) only
  ["3", "300 EVERYTHING ST", NORTH_ONE_MILE, 18, "high", 2, "F1"], // aged + expired permit (2 years) + hail, commercial
  ["4", "400 FAR AWAY RD", 30.41, 40, "low", 0, "A1"], // 10 miles north: outside a 5-mile radius
  ["5", "500 EXACTLY FIFTEEN ST", CENTER.lat + 0.001, 15, "low", 0, "A1"], // not strictly older than 15
  ["6", "600 CLOSED ST", CENTER.lat - 0.002, 5, "high", 0, "A1"], // only a closed permit and a roof_mention permit
];

export async function fixture(): Promise<Run> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run(DDL);
  for (const [id, addr, lat, age, conf, hail, code] of LEADS)
    await c.run(`insert into leads values ('${id}', '${addr}', '78701', 'CITY OF AUSTIN', ${lat}, ${CENTER.lon},
      'OWNER ${id}', 'AUSTIN', 'TX', '78701', 'travis_county', true, 1, current_date - interval 12 year, 400000,
      ${age}, year(current_date) - ${age}, 'tcad_year_built_assumes_original_roof', '${conf}', 'COMPOSITIO', 'HIP', 1990,
      'austin_permit_history_1978_plus', '${code}', 0, null, null, null, ${hail}, ${hail ? 2.0 : "null"},
      ${hail ? "current_date - interval 1 year" : "null"}, 'https://travis.prodigycad.com/property-detail/${id}')`);
  const permit = (
    num: string,
    propId: string,
    lat: number,
    bucket: string,
    work: string,
    years: number,
    contractor: string | null,
  ) =>
    c.run(`insert into roofing_permits values ('austin:${num}', '${num}', 'Building Permit', 'Repair', '${bucket === "open" ? "Active" : bucket === "expired_unfinaled" ? "Expired" : "Final"}',
      '${bucket}', '${work}', current_date - interval ${years} year, current_date - interval ${years} year,
      current_date - interval ${years} year, null, ${bucket === "closed" ? "current_date - interval 1 year" : "null"}, null,
      '${propId}', ${lat}, ${CENTER.lon}, 'ADDR ${propId}', 'Reroof', 12000, ${contractor ? `'${contractor}'` : "null"}, null,
      '5125550100', 'AUSTIN', ${contractor ? `'k_${contractor.replaceAll(" ", "_")}'` : "null"}, 'https://abc.austintexas.gov/${num}')`);
  await permit("2017-001 BP", "2", NORTH_HALF_MILE, "open", "roof_replacement", 7, "ACME ROOFING");
  await permit("2024-002 BP", "3", NORTH_ONE_MILE, "expired_unfinaled", "roof_repair", 2, "BETA ROOFING");
  await permit("2020-003 BP", "6", CENTER.lat - 0.002, "closed", "roof_replacement", 3, "ACME ROOFING");
  await permit("2022-004 BP", "6", CENTER.lat - 0.002, "open", "roof_mention", 4, null);
  await c.run(`insert into contractors values
    ('k_ACME_ROOFING', 'ACME ROOFING LLC', 'resolved_exact_name', null, 'excluded_no_public_api_http_403', '1234', 12, null),
    ('k_BETA_ROOFING', null, 'unresolved_no_registry_match', null, 'excluded_no_public_api_http_403', null, 3, null)`);
  await c.run(`insert into hail_events values
    ('h1', current_date - interval 1 year, ${NORTH_ONE_MILE}, ${CENTER.lon}, 2.0),
    ('h2', current_date - interval 40 year, ${CENTER.lat}, ${CENTER.lon}, 3.0)`);
  await c.run(PLACES_SQL);
  return async (sql: string): Promise<Row[]> => {
    const r = await c.runAndReadAll(sql);
    return r.getRowObjectsJson() as Row[];
  };
}

/** DuckDB JSON rows return BIGINT/DATE as strings; normalize for assertions. */
export const n = (v: unknown) => Number(v);
