// Display helpers and plain-language labels for the snapshot's enumerations (pipeline data contract).
import type { LeadInput } from "../shared/leads";
import type { Row } from "../shared/tools";
import type { Snapshot } from "./api";

export const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number")
    return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};
export const year = (v: unknown) => (typeof v === "number" ? String(v) : "—");
export const money = (v: unknown) =>
  typeof v === "number"
    ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";
export const date = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)
    ? new Date(`${v.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
export const duration = (days: unknown) => {
  if (typeof days !== "number") return "—";
  if (days < 60) return `${days} days`;
  if (days < 730) return `${Math.round(days / 30.44)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
};

const LABELS: Record<string, string> = {
  permit_final_roof_replacement: "Finaled re-roof permit",
  permit_issued_roof_replacement_unfinaled: "Re-roof permit, not finaled",
  tcad_year_built_assumes_original_roof: "Year built (assumes original roof)",
  unknown: "Unknown",
  high: "High",
  medium: "Medium",
  low: "Low",
  very_low: "Very low",
  none: "None",
  open: "Open",
  expired_unfinaled: "Expired, never finaled",
  closed: "Closed",
  void: "Void / cancelled",
  roof_replacement: "Roof replacement",
  roof_repair: "Roof repair",
  roof_mention: "Mentions roof",
  travis_county: "Travis County",
  austin_metro: "Austin metro (outside Travis)",
  texas_other: "Elsewhere in Texas",
  out_of_state: "Out of state",
  international: "International",
  resolved_exact_name: "Matched to Texas registry",
  unresolved_no_registry_match: "No Texas registry match",
  pending_registry_refresh: "Registry check pending",
  austin_permit_history_1978_plus: "City of Austin permit history (1978+)",
  austin_etj_or_limited_purpose_permits: "Partial: Austin ETJ / limited-purpose permits",
  no_county_building_permits_in_texas: "None: unincorporated Travis County issues no building permits",
  municipal_permits_not_yet_ingested: "None yet: city permits not ingested",
  excluded_no_public_api_http_403: "Not available: BBB offers no public API",
  blocked_http_403_pending_bbb_api: "Not available: BBB offers no public API",
};
export const label = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  if (LABELS[s]) return LABELS[s];
  const amb = /^ambiguous_(\d+)_registry_matches$/.exec(s);
  if (amb) return `${amb[1]} possible registry matches`;
  return s;
};

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Turn any result row that has a property id into a lead record, keeping the evidence that qualified it. */
export function toLeadInput(r: Row, snapshot: Snapshot, source: "finder" | "agent" | "property"): LeadInput | null {
  const propId = strOrNull(r.prop_id);
  const address = strOrNull(r.situs_address) ?? strOrNull(r.address);
  if (!propId || !/^\d{1,12}$/.test(propId) || !address) return null;
  const lat = num(r.latitude);
  const lon = num(r.longitude);
  const inBox = lat !== null && lon !== null && lat >= 29.9 && lat <= 30.7 && lon >= -98.3 && lon <= -97.3;
  const permitYears = num(r.oldest_open_years) ?? num(r.open_years);
  const url = strOrNull(r.source_detail_url);
  return {
    prop_id: propId,
    address,
    latitude: inBox ? lat : null,
    longitude: inBox ? lon : null,
    owner_name: strOrNull(r.owner_name),
    permit_number: strOrNull(r.oldest_open_permit) ?? strOrNull(r.permit_number),
    source,
    source_run_id: snapshot.run_id,
    source_url: url?.startsWith("https://") ? url : null,
    priority: (num(r.lead_score) ?? 0) >= 60 || (permitYears ?? 0) >= 5 ? "high" : "medium",
    signals: {
      roof_age_years: num(r.roof_age_years),
      roof_year: num(r.roof_year),
      roof_age_basis: strOrNull(r.roof_age_basis),
      roof_age_confidence: strOrNull(r.roof_age_confidence),
      roof_covering: strOrNull(r.roof_covering),
      open_permit_number: strOrNull(r.oldest_open_permit) ?? (permitYears !== null ? strOrNull(r.permit_number) : null),
      open_permit_status: strOrNull(r.oldest_open_status) ?? (permitYears !== null ? strOrNull(r.status) : null),
      open_permit_years: permitYears,
      contractor: strOrNull(r.oldest_open_contractor) ?? strOrNull(r.contractor_company_name),
      contractor_identity: strOrNull(r.contractor_identity),
      bbb_rating: strOrNull(r.bbb_rating),
      severe_hail_reports: num(r.severe_hail_reports_since_roof) ?? num(r.hail_reports),
      lead_score: num(r.lead_score),
      permit_history_coverage: strOrNull(r.permit_history_coverage),
    },
  };
}
