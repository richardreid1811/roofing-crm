// CRM lead records: pipeline by stage, search, and a detail panel to work a lead.
import { useCallback, useEffect, useState } from "react";
import { PRIORITIES, STAGE_LABEL, STAGES, type Lead, type LeadEvent, type Stage } from "../../shared/leads";
import { api } from "../api";
import { date, fmt, label } from "../format";
import { useApp } from "../state";

export default function Leads({ leadId }: { leadId?: string }) {
  const { refreshLeads, toast } = useApp();
  const [stage, setStage] = useState<Stage | "all">("all");
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<Stage, number> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.listLeads({ stage: stage === "all" ? undefined : stage, q: q.trim() || undefined });
      setLeads(res.leads);
      setCounts(res.counts);
    } catch (e) {
      toast(`Could not load leads: ${(e as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [stage, q, toast]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const changed = useCallback(async () => {
    await Promise.all([load(), refreshLeads()]);
  }, [load, refreshLeads]);

  async function quickStage(lead: Lead, s: Stage) {
    try {
      await api.updateLead(lead.id, { stage: s });
      await changed();
    } catch (e) {
      toast(`Could not update: ${(e as Error).message}`, "error");
    }
  }

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className={`leads-page ${leadId ? "with-detail" : ""}`}>
      <section className="card">
        <div className="row between wrap">
          <h1>Leads</h1>
          <input
            className="search"
            placeholder="Search address, owner or property id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="stage-tabs" role="tablist">
          <button className={stage === "all" ? "on" : ""} onClick={() => setStage("all")}>
            All <span className="count">{total}</span>
          </button>
          {STAGES.map((s) => (
            <button key={s} className={`${stage === s ? "on" : ""} st-${s}`} onClick={() => setStage(s)}>
              {STAGE_LABEL[s]} <span className="count">{counts?.[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Property</th>
                <th>Stage</th>
                <th>Priority</th>
                <th>Why it is a lead</th>
                <th>Contractor</th>
                <th>Next action</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr
                  key={l.id}
                  className={`clickable ${l.id === leadId ? "selected" : ""}`}
                  onClick={() => (window.location.hash = `#/leads/${l.id}`)}
                >
                  <td>
                    <div className="addr">{l.address}</div>
                    <div className="muted small">{fmt(l.owner_name)}</div>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select value={l.stage} onChange={(e) => quickStage(l, e.target.value as Stage)} aria-label="Stage">
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {STAGE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`prio ${l.priority}`}>{l.priority}</span>
                  </td>
                  <td className="small">
                    <Why lead={l} />
                  </td>
                  <td className="small">{fmt(l.signals.contractor)}</td>
                  <td className="small">
                    {l.next_action_date ? date(l.next_action_date) : "—"}
                    {l.next_action ? <div className="muted">{l.next_action}</div> : null}
                  </td>
                  <td className="small muted">{new Date(l.updated_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {!leads.length && !loading && (
                <tr>
                  <td colSpan={7} className="muted center">
                    No leads {stage !== "all" ? `in ${STAGE_LABEL[stage]}` : "yet"}. Save candidates from the{" "}
                    <a href="#/finder">lead finder</a> or the <a href="#/agent">assistant</a>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {leadId && <LeadDetail id={leadId} onChanged={changed} />}
    </div>
  );
}

function Why({ lead }: { lead: Lead }) {
  const s = lead.signals;
  const parts: string[] = [];
  if (s.roof_age_years != null)
    parts.push(`Roof ~${s.roof_age_years} yrs (${label(s.roof_age_confidence).toLowerCase()})`);
  if (s.open_permit_years != null)
    parts.push(`Permit open ${s.open_permit_years} yrs${s.open_permit_status ? ` · ${s.open_permit_status}` : ""}`);
  if (s.severe_hail_reports) parts.push(`${s.severe_hail_reports} severe hail report(s)`);
  return <>{parts.length ? parts.join(" · ") : "—"}</>;
}

function LeadDetail({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const { openProperty, toast } = useApp();
  const [lead, setLead] = useState<Lead | null>(null);
  const [events, setEvents] = useState<LeadEvent[]>([]);
  const [form, setForm] = useState({ assignee: "", next_action: "", next_action_date: "" });
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getLead(id);
      setLead(res.lead);
      setEvents(res.events);
      setForm({
        assignee: res.lead.assignee ?? "",
        next_action: res.lead.next_action ?? "",
        next_action_date: res.lead.next_action_date ?? "",
      });
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, [id]);
  useEffect(() => {
    setConfirmDelete(false);
    void load();
  }, [load]);

  async function patch(p: Parameters<typeof api.updateLead>[1], msg = "Lead updated") {
    try {
      await api.updateLead(id, p);
      await Promise.all([load(), onChanged()]);
      toast(msg);
    } catch (e) {
      toast(`Could not update: ${(e as Error).message}`, "error");
    }
  }
  async function addNote() {
    if (!note.trim()) return;
    try {
      await api.addNote(id, note.trim());
      setNote("");
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      toast(`Could not add note: ${(e as Error).message}`, "error");
    }
  }
  async function remove() {
    try {
      await api.deleteLead(id);
      toast("Lead deleted");
      window.location.hash = "#/leads";
      await onChanged();
    } catch (e) {
      toast(`Could not delete: ${(e as Error).message}`, "error");
    }
  }

  if (err)
    return (
      <aside className="card lead-detail">
        <div className="error">{err}</div>
        <a href="#/leads">Back to leads</a>
      </aside>
    );
  if (!lead) return <aside className="card lead-detail muted">Loading…</aside>;
  const s = lead.signals;
  const dirty =
    form.assignee !== (lead.assignee ?? "") ||
    form.next_action !== (lead.next_action ?? "") ||
    form.next_action_date !== (lead.next_action_date ?? "");

  return (
    <aside className="card lead-detail">
      <div className="row between">
        <div>
          <h2>{lead.address}</h2>
          <div className="muted small">
            TCAD {lead.prop_id} · {fmt(lead.owner_name)}
          </div>
        </div>
        <a href="#/leads" className="button ghost" aria-label="Close">
          ✕
        </a>
      </div>

      <div className="stage-bar" role="group" aria-label="Stage">
        {STAGES.map((st) => (
          <button
            key={st}
            className={`${lead.stage === st ? "on" : ""} st-${st}`}
            onClick={() => lead.stage !== st && patch({ stage: st }, `Moved to ${STAGE_LABEL[st]}`)}
          >
            {STAGE_LABEL[st]}
          </button>
        ))}
      </div>

      <div className="grid2">
        <label className="field">
          <span>Priority</span>
          <select value={lead.priority} onChange={(e) => patch({ priority: e.target.value as Lead["priority"] })}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Assigned to</span>
          <input
            value={form.assignee}
            onChange={(e) => setForm({ ...form, assignee: e.target.value })}
            placeholder="Sales rep"
          />
        </label>
        <label className="field">
          <span>Next action</span>
          <input
            value={form.next_action}
            onChange={(e) => setForm({ ...form, next_action: e.target.value })}
            placeholder="e.g. Door knock, call owner"
          />
        </label>
        <label className="field">
          <span>Due</span>
          <input
            type="date"
            value={form.next_action_date}
            onChange={(e) => setForm({ ...form, next_action_date: e.target.value })}
          />
        </label>
      </div>
      <div className="row gap">
        <button className="primary" disabled={!dirty} onClick={() => patch(form)}>
          Save changes
        </button>
        <button onClick={() => openProperty(lead.prop_id)}>View property & permits</button>
      </div>

      <h3>Evidence at creation</h3>
      <dl className="facts">
        <dt>Roof age</dt>
        <dd>
          {s.roof_age_years != null ? `${s.roof_age_years} years` : "Unknown"} · {label(s.roof_age_basis)} (
          {label(s.roof_age_confidence)})
        </dd>
        <dt>Open permit</dt>
        <dd>
          {s.open_permit_number
            ? `${s.open_permit_number} · ${fmt(s.open_permit_status)} · ${fmt(s.open_permit_years)} years open`
            : "None"}
        </dd>
        <dt>Contractor</dt>
        <dd>
          {fmt(s.contractor)}
          {s.contractor_identity ? ` · ${label(s.contractor_identity)}` : ""}
        </dd>
        <dt>BBB</dt>
        <dd>{s.bbb_rating ?? (s.contractor ? "Not in data" : "—")}</dd>
        <dt>Hail since roof</dt>
        <dd>{s.severe_hail_reports ? `${s.severe_hail_reports} severe report(s)` : "None"}</dd>
        {s.lead_score != null && (
          <>
            <dt>Lead score</dt>
            <dd>{fmt(s.lead_score)}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          {lead.source} · snapshot {lead.source_run_id}
          {lead.source_url && (
            <>
              {" · "}
              <a href={lead.source_url} target="_blank" rel="noreferrer">
                record ↗
              </a>
            </>
          )}
        </dd>
      </dl>

      <div className="row gap wrap future-actions">
        <button disabled title="Outreach campaigns are coming soon">
          ✉ Email / SMS owner
        </button>
        <button disabled title="Estimates are coming soon">
          ▤ Create estimate
        </button>
        <button disabled title="Canvassing routes are coming soon">
          ➶ Add to route
        </button>
      </div>

      <h3>Activity</h3>
      <div className="note-box">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (call outcome, owner response…)"
          rows={2}
          maxLength={2000}
        />
        <button onClick={addNote} disabled={!note.trim()}>
          Add note
        </button>
      </div>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id} className={`ev ${e.kind}`}>
            <span className="when">{new Date(e.at).toLocaleString()}</span>
            <span className="what">
              {e.kind === "note" ? e.detail : `${e.kind === "stage" ? "Stage: " : ""}${e.detail}`}
            </span>
          </li>
        ))}
      </ol>

      <div className="danger-zone">
        {confirmDelete ? (
          <div className="row gap">
            <span className="small">Delete this lead and its activity?</span>
            <button className="danger" onClick={remove}>
              Delete
            </button>
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <button className="ghost danger-text" onClick={() => setConfirmDelete(true)}>
            Delete lead
          </button>
        )}
      </div>
    </aside>
  );
}
