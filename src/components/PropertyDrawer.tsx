// Property and permit detail: roof-age evidence, owner, hail and every roofing permit with
// status, open duration, contractor, registry identity and BBB, plus "Save as lead".
import { useEffect, useState } from "react";
import { permitStatusLabel, roofAgeText } from "../../shared/display";
import { propertyPermitsSql, propertySql, type Row } from "../../shared/tools";
import { loadRatings, recordedRating } from "../bbb";
import { query } from "../db";
import { date, duration, fmt, label, money, toLeadInput, year } from "../format";
import { useApp } from "../state";
import BbbCell from "./BbbCell";

export default function PropertyDrawer() {
  const { propertyId, openProperty, dbReady, snapshot, leadsByProp, saveLeads } = useApp();
  const [prop, setProp] = useState<Row | null>(null);
  const [permits, setPermits] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!propertyId || !dbReady) return;
    let cancelled = false;
    setProp(null);
    setPermits([]);
    setErr(null);
    (async () => {
      try {
        const [p] = await query(propertySql(propertyId));
        const ps = await query(propertyPermitsSql(propertyId));
        await loadRatings(ps.map((x) => String(x.contractor_key ?? ""))).catch(() => undefined);
        if (cancelled) return;
        if (!p) setErr(`Property ${propertyId} is not in this snapshot.`);
        setProp(p ?? null);
        setPermits(ps);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, dbReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openProperty(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openProperty]);

  if (!propertyId) return null;
  const lead = leadsByProp.get(propertyId);
  const open = permits.filter((p) => p.is_open);

  async function save() {
    if (!prop || !snapshot) return;
    const oldest = [...open].sort((a, b) => String(a.opened_date).localeCompare(String(b.opened_date)))[0];
    const input = toLeadInput(
      {
        ...prop,
        oldest_open_permit: oldest?.permit_number,
        oldest_open_status: oldest?.status,
        oldest_open_years: oldest ? Math.round((Number(oldest.duration_days) / 365.25) * 10) / 10 : null,
        oldest_open_contractor: oldest?.contractor_company_name,
        contractor_key: oldest?.contractor_key,
        contractor_identity: oldest?.contractor_identity,
        bbb_rating: oldest?.bbb_rating,
        bbb_rating_recorded: recordedRating(oldest?.contractor_key)?.rating,
      },
      snapshot,
      "property",
    );
    if (!input) return;
    setSaving(true);
    await saveLeads([input]);
    setSaving(false);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={() => openProperty(null)} />
      <aside className="drawer" role="dialog" aria-label="Property detail">
        <div className="drawer-head">
          <div>
            <h2>{prop ? fmt(prop.situs_address) : "Property"}</h2>
            <div className="muted small">
              TCAD {propertyId}
              {prop ? ` · ${label(prop.jurisdiction)}` : ""}
            </div>
          </div>
          <button className="ghost" onClick={() => openProperty(null)} aria-label="Close">
            ✕
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {!prop && !err && <p className="muted">{dbReady ? "Loading…" : "Waiting for data…"}</p>}
        {prop && (
          <>
            <div className="row gap wrap">
              {lead ? (
                <a className="button primary" href={`#/leads/${lead.id}`} onClick={() => openProperty(null)}>
                  Open lead ({lead.stage})
                </a>
              ) : (
                <button className="primary" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save as lead"}
                </button>
              )}
              <a className="button" href={String(prop.source_detail_url)} target="_blank" rel="noreferrer">
                TCAD record ↗
              </a>
              <button disabled title="Outreach is not available yet">
                Contact owner (soon)
              </button>
            </div>

            <h3>Roof</h3>
            <dl className="facts">
              <dt>Estimated roof age</dt>
              <dd>
                {prop.roof_age_years == null
                  ? "Unknown"
                  : roofAgeText(prop).startsWith("≥")
                    ? `${roofAgeText(prop).replace("yrs", "years")}: from the year built, so the true roof age is unknown`
                    : `${fmt(prop.roof_age_years)} years (roof year ${year(prop.roof_year)})`}
              </dd>
              <dt>Evidence</dt>
              <dd>
                {label(prop.roof_age_basis)} · {label(prop.roof_age_confidence)} confidence
              </dd>
              <dt>Covering / style</dt>
              <dd>
                {fmt(prop.roof_covering)} / {fmt(prop.roof_style)}
              </dd>
              <dt>Year built</dt>
              <dd>{year(prop.year_built)}</dd>
              <dt>Permit coverage</dt>
              <dd>{label(prop.permit_history_coverage)}</dd>
              <dt>Severe hail since roof</dt>
              <dd>
                {Number(prop.severe_hail_reports_since_roof) > 0
                  ? `${fmt(prop.severe_hail_reports_since_roof)} report(s), last ${date(prop.last_severe_hail_date_since_roof)}, up to ${fmt(prop.max_hail_inches_since_roof)} in`
                  : "None reported within 1 mile"}
              </dd>
            </dl>

            <h3>Owner</h3>
            <dl className="facts">
              <dt>Owner of record</dt>
              <dd>{fmt(prop.owner_name)}</dd>
              <dt>Mailing</dt>
              <dd>
                {fmt(prop.mail_city)}, {fmt(prop.mail_state)} {fmt(prop.mail_zip)} · {label(prop.owner_mail_region)}
              </dd>
              <dt>Owner-occupied</dt>
              <dd>{prop.owner_occupied_homestead ? "Yes (homestead)" : "No homestead exemption"}</dd>
              <dt>Last deed</dt>
              <dd>
                {date(prop.deed_date)}
                {prop.years_since_deed != null ? ` · ${fmt(prop.years_since_deed)} years` : ""}
              </dd>
              <dt>Properties held</dt>
              <dd>{fmt(prop.owner_property_count)}</dd>
              <dt>Market value</dt>
              <dd>{money(prop.market_val)}</dd>
            </dl>

            <h3>
              Roofing permits{" "}
              <span className="muted small">
                {permits.length} total · {open.length} open or never finaled
              </span>
            </h3>
            {!permits.length && (
              <p className="muted small">
                No roofing permits on record.{" "}
                {![
                  "austin_permit_history_1978_plus",
                  "austin_etj_or_limited_purpose_permits",
                  "lakeway_permit_history",
                ].includes(String(prop.permit_history_coverage)) &&
                  "Permit history is not available for this jurisdiction."}
              </p>
            )}
            {permits.map((p) => (
              <div key={String(p.permit_number)} className={`permit ${p.is_open ? "is-open" : ""}`}>
                <div className="row between wrap">
                  <strong>
                    <a href={String(p.source_detail_url)} target="_blank" rel="noreferrer">
                      {fmt(p.permit_number)} ↗
                    </a>
                  </strong>
                  <span className={`tag ${p.is_open ? "permit" : "closed"}`}>
                    {permitStatusLabel(p.status, p.status_bucket)}
                  </span>
                </div>
                <div className="small muted">
                  {label(p.roofing_work)} · {fmt(p.permit_type_desc)}
                </div>
                <dl className="facts compact">
                  <dt>Opened</dt>
                  <dd>{date(p.opened_date)}</dd>
                  <dt>{p.is_open ? "Open for" : "Took"}</dt>
                  <dd>
                    <strong>{duration(p.duration_days)}</strong>
                  </dd>
                  {p.expires_date != null && (
                    <>
                      <dt>Expires</dt>
                      <dd>{date(p.expires_date)}</dd>
                    </>
                  )}
                  {p.completed_date != null && (
                    <>
                      <dt>Completed</dt>
                      <dd>{date(p.completed_date)}</dd>
                    </>
                  )}
                  <dt>Contractor</dt>
                  <dd>
                    {fmt(p.contractor_company_name)}
                    {p.contractor_phone ? ` · ${String(p.contractor_phone)}` : ""}
                  </dd>
                  <dt>Registry</dt>
                  <dd>
                    {p.contractor_legal_name ? `${String(p.contractor_legal_name)} · ` : ""}
                    {label(p.contractor_identity)}
                  </dd>
                  <dt>BBB rating</dt>
                  <dd>
                    <BbbCell
                      rating={p.bbb_rating}
                      contractorKey={p.contractor_key}
                      contractorName={p.contractor_company_name}
                    />
                  </dd>
                  {p.job_valuation != null && (
                    <>
                      <dt>Valuation</dt>
                      <dd>{money(p.job_valuation)}</dd>
                    </>
                  )}
                </dl>
                {p.description != null && <p className="small desc">{String(p.description)}</p>}
              </div>
            ))}
          </>
        )}
      </aside>
    </>
  );
}
