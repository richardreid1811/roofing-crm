// Lead records in D1. All writes validate with the shared Zod contract and record an activity event.
import { Hono } from "hono";
import {
  createLeadsSchema,
  leadPatchSchema,
  noteSchema,
  STAGE_LABEL,
  STAGES,
  type Lead,
  type LeadEvent,
  type Stage,
} from "../shared/leads";
import type { AppEnv } from "./env";
import { limited } from "./limits";

// Public demo workspace without login: cap the table so it stays bounded on the free plan.
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

leads.use("*", async (c, next) => {
  if (c.req.method !== "GET" && limited(`w:${c.req.header("cf-connecting-ip") ?? "local"}`, 60))
    return c.json({ error: "rate_limited", message: "Too many changes; wait a minute." }, 429);
  await next();
});

leads.get("/", async (c) => {
  const stage = c.req.query("stage");
  const q = c.req.query("q")?.trim().slice(0, 80);
  const where: string[] = [];
  const binds: string[] = [];
  if (stage && (STAGES as readonly string[]).includes(stage)) {
    where.push("stage = ?");
    binds.push(stage);
  }
  if (q) {
    where.push("(address like ? or owner_name like ? or prop_id = ?)");
    binds.push(`%${q}%`, `%${q}%`, q);
  }
  const { results } = await c.env.DB.prepare(
    `select * from leads ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit 1000`,
  )
    .bind(...binds)
    .all<LeadRow>();
  const counts = await c.env.DB.prepare("select stage, count(*) as n from leads group by stage").all<{
    stage: Stage;
    n: number;
  }>();
  return c.json({
    leads: results.map(toLead),
    counts: Object.fromEntries(STAGES.map((s) => [s, counts.results.find((r) => r.stage === s)?.n ?? 0])),
  });
});

leads.post("/", async (c) => {
  const parsed = createLeadsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const total = await c.env.DB.prepare("select count(*) as n from leads").first<{ n: number }>();
  if ((total?.n ?? 0) + parsed.data.leads.length > MAX_LEADS)
    return c.json({ error: "full", message: `The demo workspace holds at most ${MAX_LEADS} leads.` }, 409);

  // One batch (a single D1 call) for all inserts and their "created" events, then one read: the free
  // plan allows about 50 D1 calls per request, so per-lead queries failed beyond ~16 leads.
  // One lead per property: a second save keeps the existing record (on conflict do nothing), and an
  // event is only written for a row this request inserted (its fresh id exists).
  const at = now();
  const fresh = parsed.data.leads.map((input) => ({ id: crypto.randomUUID(), input }));
  await c.env.DB.batch(
    fresh.flatMap(({ id, input }) => [
      c.env.DB.prepare(
        `insert into leads (id, prop_id, address, latitude, longitude, owner_name, permit_number, priority, source,
                            source_run_id, source_url, signals, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (prop_id) do nothing`,
      ).bind(
        id,
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
    `select * from leads where prop_id in (${propIds.map(() => "?").join(", ")})`,
  )
    .bind(...propIds)
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
  const row = await c.env.DB.prepare("select * from leads where id = ?").bind(c.req.param("id")).first<LeadRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare("select * from lead_events where lead_id = ? order by id desc")
    .bind(row.id)
    .all<LeadEvent>();
  return c.json({ lead: toLead(row), events: results });
});

leads.patch("/:id", async (c) => {
  const parsed = leadPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const before = await c.env.DB.prepare("select * from leads where id = ?").bind(c.req.param("id")).first<LeadRow>();
  if (!before) return c.json({ error: "not_found" }, 404);
  const patch = parsed.data;
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  await c.env.DB.prepare(`update leads set ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`)
    .bind(...cols.map((k) => patch[k] ?? null), now(), before.id)
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
  const row = await c.env.DB.prepare("select * from leads where id = ?").bind(before.id).first<LeadRow>();
  return c.json({ lead: toLead(row!) });
});

leads.post("/:id/notes", async (c) => {
  const parsed = noteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("update leads set updated_at = ? where id = ?").bind(now(), id).run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  await addEvent(c.env.DB, id, "note", parsed.data.text);
  return c.json({ ok: true }, 201);
});

leads.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Explicit event cleanup: D1 enforces foreign keys, but do not depend on cascade settings.
  await c.env.DB.batch([
    c.env.DB.prepare("delete from lead_events where lead_id = ?").bind(id),
    c.env.DB.prepare("delete from leads where id = ?").bind(id),
  ]);
  return c.body(null, 204);
});
