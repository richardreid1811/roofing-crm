// Lead records in D1. All writes validate with the shared Zod contract and record an activity event.
// Every query is scoped to the request's workspace (see workspaces.ts); no key means the demo workspace.
import { Hono } from "hono";
import {
  createLeadsSchema,
  LEADS_PAGE,
  leadPatchSchema,
  MAX_LEADS_PAGE,
  noteSchema,
  STAGE_LABEL,
  STAGES,
  type Lead,
  type LeadEvent,
  type LeadRef,
  type Stage,
} from "../shared/leads";
import { DEMO_WORKSPACE_ID } from "../shared/workspaces";
import type { AppEnv } from "./env";
import { limitWrites, resolveWorkspace } from "./workspaces";

// Cap each workspace (the public demo has no login) so the database stays bounded on the free plan.
export const MAX_LEADS = 5000;

type LeadRow = Omit<Lead, "signals"> & { signals: string };
const toLead = (r: LeadRow): Lead => ({ ...r, signals: JSON.parse(r.signals) as Lead["signals"] });
const now = () => new Date().toISOString();

async function addEvent(db: D1Database, leadId: string, kind: LeadEvent["kind"], detail: string) {
  await db
    .prepare("insert into lead_events (lead_id, at, kind, detail) values (?, ?, ?, ?)")
    .bind(leadId, now(), kind, detail)
    .run();
}

export const leads = new Hono<AppEnv>();

leads.use("*", resolveWorkspace, limitWrites);

const byId = (c: { env: AppEnv["Bindings"]; get: (k: "workspace") => string }, id: string) =>
  c.env.DB.prepare("select * from leads where id = ? and workspace_id = ?")
    .bind(id, c.get("workspace"))
    .first<LeadRow>();

leads.get("/", async (c) => {
  const stage = c.req.query("stage");
  const q = c.req.query("q")?.trim().slice(0, 80);
  const ws = c.get("workspace");
  const where: string[] = ["workspace_id = ?"];
  const binds: string[] = [ws];
  if (stage && (STAGES as readonly string[]).includes(stage)) {
    where.push("stage = ?");
    binds.push(stage);
  }
  if (q) {
    where.push("(address like ? or owner_name like ? or prop_id = ?)");
    binds.push(`%${q}%`, `%${q}%`, q);
  }
  // Paged: `total` is every match, and `next_offset` asks for the next page (null on the last one).
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit")) || LEADS_PAGE), 1), MAX_LEADS_PAGE);
  const offset = Math.max(Math.trunc(Number(c.req.query("offset")) || 0), 0);
  const [page, matching, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `select * from leads where ${where.join(" and ")} order by updated_at desc, id limit ? offset ?`,
    ).bind(...binds, limit, offset),
    c.env.DB.prepare(`select count(*) as n from leads where ${where.join(" and ")}`).bind(...binds),
    c.env.DB.prepare("select stage, count(*) as n from leads where workspace_id = ? group by stage").bind(ws),
  ]);
  const rows = page.results as LeadRow[];
  const total = (matching.results[0] as { n: number } | undefined)?.n ?? 0;
  const byStage = counts.results as { stage: Stage; n: number }[];
  return c.json({
    leads: rows.map(toLead),
    total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    counts: Object.fromEntries(STAGES.map((s) => [s, byStage.find((r) => r.stage === s)?.n ?? 0])),
  });
});

// Every saved property in the workspace (at most MAX_LEADS small rows), for "already a lead" markers.
leads.get("/index", async (c) => {
  const { results } = await c.env.DB.prepare("select id, prop_id, stage from leads where workspace_id = ?")
    .bind(c.get("workspace"))
    .all<LeadRef>();
  return c.json({ leads: results });
});

leads.post("/", async (c) => {
  const parsed = createLeadsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const ws = c.get("workspace");
  const total = await c.env.DB.prepare("select count(*) as n from leads where workspace_id = ?")
    .bind(ws)
    .first<{ n: number }>();
  if ((total?.n ?? 0) + parsed.data.leads.length > MAX_LEADS)
    return c.json(
      {
        error: "full",
        message: `${ws === DEMO_WORKSPACE_ID ? "The demo" : "A"} workspace holds at most ${MAX_LEADS} leads.`,
      },
      409,
    );

  // One batch (a single D1 call) for all inserts and their "created" events, then one read: the free
  // plan allows about 50 D1 calls per request, so per-lead queries failed beyond ~16 leads.
  // One lead per property per workspace: a second save keeps the existing record (on conflict do nothing,
  // which needs no conflict target, so it holds across the unique-index migration), and an event is only
  // written for a row this request inserted (its fresh id exists).
  const at = now();
  const fresh = parsed.data.leads.map((input) => ({ id: crypto.randomUUID(), input }));
  await c.env.DB.batch(
    fresh.flatMap(({ id, input }) => [
      c.env.DB.prepare(
        `insert into leads (id, workspace_id, prop_id, address, latitude, longitude, owner_name, permit_number,
                            priority, source, source_run_id, source_url, signals, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      ).bind(
        id,
        ws,
        input.prop_id,
        input.address,
        input.latitude ?? null,
        input.longitude ?? null,
        input.owner_name ?? null,
        input.permit_number ?? null,
        input.priority,
        input.source,
        input.source_run_id,
        input.source_url ?? null,
        JSON.stringify(input.signals),
        at,
        at,
      ),
      c.env.DB.prepare(
        "insert into lead_events (lead_id, at, kind, detail) select id, ?, 'created', ? from leads where id = ?",
      ).bind(at, `Created from ${input.source} (snapshot ${input.source_run_id})`, id),
    ]),
  );
  const propIds = [...new Set(fresh.map((f) => f.input.prop_id))];
  const { results } = await c.env.DB.prepare(
    // The ids go in as one JSON parameter: D1 allows at most 100 bound parameters per statement.
    "select * from leads where workspace_id = ? and prop_id in (select value from json_each(?))",
  )
    .bind(ws, JSON.stringify(propIds))
    .all<LeadRow>();
  const newIds = new Set(fresh.map((f) => f.id));
  const created: Lead[] = [];
  const existing: Lead[] = [];
  const byProp = new Map(results.map((r) => [r.prop_id, r]));
  for (const propId of propIds) {
    const row = byProp.get(propId);
    if (row) (newIds.has(row.id) ? created : existing).push(toLead(row));
  }
  return c.json({ created, existing }, created.length ? 201 : 200);
});

leads.get("/:id", async (c) => {
  const row = await byId(c, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare("select * from lead_events where lead_id = ? order by id desc")
    .bind(row.id)
    .all<LeadEvent>();
  return c.json({ lead: toLead(row), events: results });
});

leads.patch("/:id", async (c) => {
  const parsed = leadPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const before = await byId(c, c.req.param("id"));
  if (!before) return c.json({ error: "not_found" }, 404);
  const patch = parsed.data;
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  await c.env.DB.prepare(
    `update leads set ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ? and workspace_id = ?`,
  )
    .bind(...cols.map((k) => patch[k] ?? null), now(), before.id, c.get("workspace"))
    .run();
  if (patch.stage && patch.stage !== before.stage)
    await addEvent(c.env.DB, before.id, "stage", `${STAGE_LABEL[before.stage]} → ${STAGE_LABEL[patch.stage]}`);
  const changed = cols.filter((k) => k !== "stage" && (patch[k] ?? null) !== (before[k] ?? null));
  if (changed.length)
    await addEvent(
      c.env.DB,
      before.id,
      "update",
      changed.map((k) => `${k.replaceAll("_", " ")}: ${patch[k] ?? "cleared"}`).join("; "),
    );
  const row = await byId(c, before.id);
  return c.json({ lead: toLead(row!) });
});

leads.post("/:id/notes", async (c) => {
  const parsed = noteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("update leads set updated_at = ? where id = ? and workspace_id = ?")
    .bind(now(), id, c.get("workspace"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  await addEvent(c.env.DB, id, "note", parsed.data.text);
  return c.json({ ok: true }, 201);
});

leads.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Explicit event cleanup: D1 enforces foreign keys, but do not depend on cascade settings.
  const ws = c.get("workspace");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "delete from lead_events where lead_id in (select id from leads where id = ? and workspace_id = ?)",
    ).bind(id, ws),
    c.env.DB.prepare("delete from leads where id = ? and workspace_id = ?").bind(id, ws),
  ]);
  return c.body(null, 204);
});
