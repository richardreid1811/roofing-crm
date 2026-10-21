// Retrieval-augmented assistant: the model (Workers AI via the Worker) picks a tool, the browser runs
// it as SQL over the IPFS snapshot, and the model answers from those rows. Every tool call shows its
// SQL and results, and result rows can be saved as CRM leads.
import { Fragment, useState } from "react";
import type { Row } from "../../shared/tools";
import { api } from "../api";
import BbbCell from "../components/BbbCell";
import { runTool } from "../db";
import { fmt, label, toLeadInput } from "../format";
import { useApp } from "../state";

type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
type ToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "json"; value: unknown } | { type: "error-text"; value: string };
};
type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };
type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: unknown; rows: Row[]; total?: unknown; sql: string; error?: string }
  | { kind: "error"; text: string };

const MAX_STEPS = 5;
const MAX_ROWS_TO_MODEL = 12;
const DROP_FOR_MODEL = new Set([
  "latitude",
  "longitude",
  "bbb_lookup_url",
  "signal_aged_roof",
  "signal_open_permit",
  "signal_hail",
]);
const EXAMPLES = [
  "Show me open roofing permits older than five years within five miles of Rollingwood",
  "Which roofs older than 20 years within 1 mile of Hyde Park have an open roofing permit or hail damage?",
  "Find long-open roofing permits near downtown Austin and who the contractor is",
  "Which homes near Allandale were hit by large hail in the last 3 years?",
];

const compact = (rows: Row[]) =>
  rows.slice(0, MAX_ROWS_TO_MODEL).map((r) =>
    Object.fromEntries(
      Object.entries(r)
        .filter(([k, v]) => !DROP_FOR_MODEL.has(k) && v !== null && v !== undefined)
        .map(([k, v]) => [k, typeof v === "string" && v.length > 140 ? `${v.slice(0, 140)}…` : v]),
    ),
  );

// Minimal safe markdown: **bold**, line breaks and https links. React escapes the rest.
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|https:\/\/[^\s)\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith("https://") ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p.replace(/^https:\/\//, "").slice(0, 60)}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export default function Agent() {
  const { dbReady } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setInput("");
    setTurns((t) => [...t, { kind: "user", text: question }]);
    let msgs: Msg[] = [...history, { role: "user", content: question }];
    let mode: "auto" | "answer" = "auto";
    let finalText = "";
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const out = await api.chat(msgs, mode);
        if (!out.toolCalls.length) {
          finalText = out.text.trim() || "(no answer)";
          setTurns((t) => [...t, { kind: "assistant", text: finalText }]);
          break;
        }
        const calls: ToolCallPart[] = out.toolCalls.map((c) => ({
          type: "tool-call",
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input ?? {},
        }));
        const results: ToolResultPart[] = [];
        for (const [i, call] of calls.entries()) {
          const invalid = out.toolCalls[i].error;
          try {
            if (invalid) throw new Error(invalid);
            const res = await runTool(call.toolName, call.input);
            setTurns((t) => [
              ...t,
              {
                kind: "tool",
                name: call.toolName,
                args: res.args,
                rows: res.rows,
                total: res.count?.matches,
                sql: res.sql,
              },
            ]);
            results.push({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: {
                type: "json",
                value: {
                  ...(res.resolvedPlace ? { search_center: res.resolvedPlace } : {}),
                  ...(res.count ? { total_matches: res.count } : {}),
                  returned_rows: res.rows.length,
                  rows: compact(res.rows),
                } as never,
              },
            });
          } catch (e) {
            const error = String((e as Error).message ?? e);
            setTurns((t) => [...t, { kind: "tool", name: call.toolName, args: call.input, rows: [], sql: "", error }]);
            results.push({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "error-text", value: error },
            });
          }
        }
        msgs = [...msgs, { role: "assistant", content: calls }, { role: "tool", content: results }];
        // Llama tends to repeat tool calls instead of answering: after one tool round, ask for the answer.
        mode = "answer";
      }
    } catch (e) {
      setTurns((t) => [...t, { kind: "error", text: String((e as Error).message ?? e) }]);
    } finally {
      // Carry only the text of earlier exchanges into the next question.
      setHistory((h) =>
        [
          ...h,
          { role: "user" as const, content: question },
          ...(finalText ? [{ role: "assistant" as const, content: finalText }] : []),
        ].slice(-8),
      );
      setBusy(false);
    }
  }

  return (
    <div className="agent">
      <section className="card">
        <h1>Assistant</h1>
        <p className="muted small">
          Ask in plain English. Llama 3.3 70B (Cloudflare Workers AI) chooses a search; the search runs as SQL in your
          browser over the published Travis County snapshot, and the answer cites those records. Save any result as a
          lead from the table under each search.
        </p>
        <div className="examples">
          {EXAMPLES.map((q) => (
            <button key={q} onClick={() => ask(q)} disabled={!dbReady || busy}>
              {q}
            </button>
          ))}
        </div>
      </section>
      <section className="card chat">
        {turns.map((t, i) =>
          t.kind === "user" ? (
            <div key={i} className="msg user">
              {t.text}
            </div>
          ) : t.kind === "assistant" ? (
            <div key={i} className="msg assistant">
              <Rich text={t.text} />
            </div>
          ) : t.kind === "error" ? (
            <div key={i} className="msg error">
              {t.text}
            </div>
          ) : (
            <ToolTurn key={i} turn={t} />
          ),
        )}
        {busy && <div className="msg assistant muted">Working…</div>}
        {!turns.length && (
          <p className="muted">
            Try an example above, or ask about roof age, open permits, contractors or hail anywhere in Travis County.
          </p>
        )}
      </section>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={dbReady ? "Ask about roofing opportunities…" : "Loading data from IPFS…"}
          disabled={!dbReady || busy}
          maxLength={1000}
        />
        <button className="primary" disabled={!dbReady || busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

function ToolTurn({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const { snapshot, saveLeads, leadsByProp, openProperty } = useApp();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const rows = turn.rows;
  const savableIdx = rows
    .map((r, i) => (r.prop_id && !leadsByProp.has(String(r.prop_id)) ? i : -1))
    .filter((i) => i >= 0);

  async function save() {
    if (!snapshot) return;
    const inputs = [...selected].map((i) => toLeadInput(rows[i], snapshot, "agent")).filter((x) => x !== null);
    if ((await saveLeads(inputs)) !== null) setSelected(new Set());
  }

  return (
    <div className="msg tool">
      <details>
        <summary>
          Search <code>{turn.name}</code> {JSON.stringify(turn.args)} →{" "}
          {turn.error ? (
            <span className="error">{turn.error}</span>
          ) : (
            `${rows.length} rows${turn.total !== undefined ? ` of ${fmt(turn.total)} matches` : ""}`
          )}
        </summary>
        {turn.sql && <pre>{turn.sql.trim()}</pre>}
      </details>
      {rows.length > 0 && rows[0].prop_id !== undefined && (
        <>
          <div className="scroll short">
            <table className="tbl">
              <thead>
                <tr>
                  <th />
                  <th>Address</th>
                  <th>Roof age</th>
                  <th>Permit</th>
                  <th>Contractor</th>
                  <th>BBB</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const lead = r.prop_id ? leadsByProp.get(String(r.prop_id)) : undefined;
                  const contractor = r.contractor_company_name ?? r.oldest_open_contractor;
                  return (
                    <tr
                      key={i}
                      className={r.prop_id ? "clickable" : ""}
                      onClick={() => r.prop_id && openProperty(String(r.prop_id))}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        {lead ? (
                          <a href={`#/leads/${lead.id}`} className="saved" title="Already a lead">
                            ✓
                          </a>
                        ) : r.prop_id ? (
                          <input
                            type="checkbox"
                            aria-label="Select"
                            checked={selected.has(i)}
                            onChange={() =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (n.has(i)) n.delete(i);
                                else n.add(i);
                                return n;
                              })
                            }
                          />
                        ) : (
                          <span className="muted" title="Permit not linked to a TCAD property">
                            –
                          </span>
                        )}
                      </td>
                      <td>{fmt(r.situs_address ?? r.address)}</td>
                      <td>
                        {r.roof_age_years != null ? `${fmt(r.roof_age_years)} yrs` : "—"}
                        {r.roof_age_confidence ? (
                          <div className="muted small">{label(r.roof_age_confidence)}</div>
                        ) : null}
                      </td>
                      <td className="small">
                        {r.permit_number || r.oldest_open_permit ? (
                          <>
                            {fmt(r.permit_number ?? r.oldest_open_permit)}
                            <div className="muted">
                              {fmt(r.status ?? r.oldest_open_status)}
                              {r.open_years != null || r.oldest_open_years != null
                                ? ` · ${fmt(r.open_years ?? r.oldest_open_years)} yrs open`
                                : ""}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="small">{fmt(contractor)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <BbbCell rating={r.bbb_rating} contractorKey={r.contractor_key} contractorName={contractor} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row gap">
            <button className="small" onClick={() => setSelected(new Set(savableIdx))} disabled={!savableIdx.length}>
              Select all
            </button>
            <button className="primary small" onClick={save} disabled={!selected.size}>
              Save {selected.size || ""} as lead{selected.size === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
