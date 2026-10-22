// Private workspaces (capability links), the durable write limiter and the per-workspace unique index,
// in the Workers runtime against a real (local) D1 with the migrations applied.
import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Lead } from "../../shared/leads";
import type { Workspace } from "../../shared/workspaces";
import { overLimit } from "../../worker/limits";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    MIGRATION_DB: D1Database;
  }
}

const worker = (exports as unknown as { default: Fetcher }).default;
const e = env as unknown as {
  DB: D1Database;
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
};

// A client IP of its own, so these writes never share a rate-limit window with the other test file.
let ipSeq = 0;
const call = (path: string, init: RequestInit & { key?: string; ip?: string } = {}) => {
  const { key, ip, ...rest } = init;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": ip ?? "203.0.113.7",
  };
  if (key) headers["x-workspace-key"] = key;
  return worker.fetch(new Request(`https://crm.test/api${path}`, { ...rest, headers }));
};
const json = async <T>(res: Response) => (await res.json()) as T;

// Prop ids in the 88xxxx range: never substrings of the ids the leads test searches for.
const lead = (propId: string) => ({
  prop_id: propId,
  address: `${propId} WORKSPACE ST`,
  source: "finder",
  source_run_id: "20261020T225920Z",
});
const save = (propIds: string[], key?: string) =>
  call("/leads", { method: "POST", key, body: JSON.stringify({ leads: propIds.map(lead) }) });

async function createWorkspace(name: string) {
  const res = await call("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
    ip: `198.51.100.${++ipSeq}`,
  });
  expect(res.status).toBe(201);
  return json<{ workspace: Workspace; key: string }>(res);
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
});

describe("workspaces", () => {
  it("creates a workspace, returns its key once and stores only a SHA-256 hash", async () => {
    const { workspace, key } = await createWorkspace("Acme Roofing");
    expect(workspace).toMatchObject({ name: "Acme Roofing", public: false });
    expect(key).toMatch(/^wsk_[A-Za-z0-9_-]{43}$/);
    const row = await e.DB.prepare("select * from workspaces where id = ?").bind(workspace.id).first<{
      key_hash: string;
    }>();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(row?.key_hash).toBe(hash);
    expect(JSON.stringify(row)).not.toContain(key);

    const self = await json<{ workspace: Workspace }>(await call("/workspaces/self", { key }));
    expect(self.workspace).toEqual({ id: workspace.id, name: "Acme Roofing", public: false });
    for (const bad of [{}, { name: "" }, { name: "x".repeat(61) }, { name: "ok", extra: 1 }])
      expect((await call("/workspaces", { method: "POST", body: JSON.stringify(bad) })).status).toBe(400);
  });

  it("no header means the public demo workspace", async () => {
    const self = await json<{ workspace: Workspace }>(await call("/workspaces/self"));
    expect(self.workspace).toEqual({ id: "demo", name: "Demo workspace (public)", public: true });
    const { created } = await json<{ created: Lead[] }>(await save(["880001"]));
    const row = await e.DB.prepare("select workspace_id from leads where id = ?").bind(created[0].id).first();
    expect(row).toEqual({ workspace_id: "demo" });
    expect((await call("/workspaces/self", { method: "DELETE" })).status).toBe(403);
  });

  it("refuses an unknown or malformed key with 401 on every lead route and BBB writes", async () => {
    const unknown = `wsk_${"A".repeat(43)}`;
    for (const key of [unknown, "not-a-key"]) {
      expect((await call("/leads", { key })).status).toBe(401);
      expect((await save(["880002"], key)).status).toBe(401);
      expect((await call("/leads/anything", { key })).status).toBe(401);
      expect((await call("/workspaces/self", { key })).status).toBe(401);
      const bbb = { contractor_key: "contractor:0123456789abcdef0123456789abcdef", contractor_name: "X", rating: "A" };
      expect((await call("/bbb", { method: "POST", key, body: JSON.stringify(bbb) })).status).toBe(401);
    }
    const rows = await e.DB.prepare("select count(*) as n from leads where prop_id = '880002'").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("isolates leads: a private workspace and the demo never see each other's leads", async () => {
    const a = await createWorkspace("Workspace A");
    const b = await createWorkspace("Workspace B");
    const { created } = await json<{ created: Lead[] }>(await save(["880010", "880011"], a.key));
    expect(created).toHaveLength(2);
    const demoOnly = await json<{ created: Lead[] }>(await save(["880012"]));
    expect(demoOnly.created).toHaveLength(1);

    const inA = await json<{ leads: Lead[]; counts: Record<string, number> }>(await call("/leads", { key: a.key }));
    expect(inA.leads.map((l) => l.prop_id).sort()).toEqual(["880010", "880011"]);
    expect(inA.counts.new).toBe(2);
    const inB = await json<{ leads: Lead[]; counts: Record<string, number> }>(await call("/leads", { key: b.key }));
    expect(inB.leads).toEqual([]);
    expect(inB.counts.new).toBe(0);
    const demo = await json<{ leads: Lead[] }>(await call("/leads"));
    expect(demo.leads.map((l) => l.prop_id)).toContain("880012");
    expect(demo.leads.map((l) => l.prop_id)).not.toContain("880010");

    // A lead id from another workspace behaves as missing for read, edit, note and delete.
    const id = created[0].id;
    expect((await call(`/leads/${id}`)).status).toBe(404);
    expect((await call(`/leads/${id}`, { key: b.key })).status).toBe(404);
    expect((await call(`/leads/${id}`, { method: "PATCH", body: JSON.stringify({ stage: "won" }) })).status).toBe(404);
    expect((await call(`/leads/${id}/notes`, { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(
      404,
    );
    expect((await call(`/leads/${id}`, { method: "DELETE" })).status).toBe(204);
    const still = await json<{ lead: Lead }>(await call(`/leads/${id}`, { key: a.key }));
    expect(still.lead.stage).toBe("new");

    // Deleting the workspace removes its leads and activity, and the key stops working.
    expect((await call("/workspaces/self", { method: "DELETE", key: a.key })).status).toBe(204);
    expect((await call("/leads", { key: a.key })).status).toBe(401);
    const left = await e.DB.prepare(
      "select (select count(*) from leads where prop_id in ('880010', '880011')) as leads, (select count(*) from lead_events where lead_id = ?) as events",
    )
      .bind(id)
      .first();
    expect(left).toEqual({ leads: 0, events: 0 });
  });

  it("keeps one lead per property per workspace", async () => {
    const a = await createWorkspace("Unique A");
    const demo = await json<{ created: Lead[] }>(await save(["880020"]));
    const first = await save(["880020"], a.key);
    expect(first.status).toBe(201);
    const inA = await json<{ created: Lead[] }>(first);
    expect(inA.created[0].id).not.toBe(demo.created[0].id);

    const again = await save(["880020"], a.key);
    expect(again.status).toBe(200);
    expect((await json<{ existing: Lead[] }>(again)).existing.map((l) => l.id)).toEqual([inA.created[0].id]);
    const n = await e.DB.prepare("select count(*) as n from leads where prop_id = '880020'").first<{ n: number }>();
    expect(n?.n).toBe(2);
    await expect(
      e.DB.prepare(
        "insert into leads (id, workspace_id, prop_id, address, source, source_run_id, created_at, updated_at) values ('dup', 'demo', '880020', 'x', 'finder', 'r', 't', 't')",
      ).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("durable write limiter", () => {
  it("counts per key within a fixed window and starts again in the next window", async () => {
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 5);
    const key = "test:window";
    for (let i = 0; i < 3; i++)
      expect(await overLimit(e.DB, key, 3, { now: t0 + i * 1000, cleanup: false })).toBe(false);
    expect(await overLimit(e.DB, key, 3, { now: t0 + 50_000, cleanup: false })).toBe(true);
    expect(await overLimit(e.DB, "test:other", 3, { now: t0 + 50_000, cleanup: false })).toBe(false);
    expect(await overLimit(e.DB, key, 3, { now: t0 + 60_000, cleanup: false })).toBe(false);
    const rows = await e.DB.prepare("select window_start, count from rate_limits where key = ? order by window_start")
      .bind(key)
      .all();
    expect(rows.results).toEqual([
      { window_start: t0 / 1000 - 5, count: 4 },
      { window_start: t0 / 1000 + 55, count: 1 },
    ]);

    // Cleanup drops windows older than two hours, in the same batch as the upsert.
    await overLimit(e.DB, "test:later", 3, { now: t0 + 3 * 3600_000, cleanup: true });
    const old = await e.DB.prepare("select count(*) as n from rate_limits where key = ?")
      .bind(key)
      .first<{ n: number }>();
    expect(old?.n).toBe(0);
  });

  it("returns 429 after 60 writes a minute per client and workspace, and counts across requests", async () => {
    // Align to the start of a minute window so all 61 writes land in one window.
    const ip = "192.0.2.61";
    const toNextMinute = 60_000 - (Date.now() % 60_000);
    if (toNextMinute < 15_000) await new Promise((r) => setTimeout(r, toNextMinute + 50));
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call("/leads/none", { method: "DELETE", ip })).status);
    expect(statuses.slice(0, 60).every((s) => s === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Reads are not limited; another workspace from the same client has its own window.
    expect((await call("/leads", { ip })).status).toBe(200);
    const a = await createWorkspace("Limiter");
    expect((await call("/leads/none", { method: "DELETE", ip, key: a.key })).status).toBe(204);
  });
});

describe("migration 0004", () => {
  it("rebuilds leads with a per-workspace unique index, keeping every lead, event and id", async () => {
    const db = e.MIGRATION_DB;
    await applyD1Migrations(db, e.TEST_MIGRATIONS.slice(0, 3));
    await db.batch([
      db.prepare(
        "insert into leads (id, prop_id, address, stage, source, source_run_id, signals, created_at, updated_at) values ('l1', '237487', '2601 ELLISE AVE', 'contacted', 'finder', 'r', '{\"roof_age_years\":22}', 't1', 't2')",
      ),
      db.prepare("insert into lead_events (lead_id, at, kind, detail) values ('l1', 't1', 'created', 'Created')"),
      db.prepare("insert into lead_events (lead_id, at, kind, detail) values ('l1', 't2', 'note', 'Called owner')"),
    ]);
    await applyD1Migrations(db, e.TEST_MIGRATIONS);

    expect(await db.prepare("select id, workspace_id, prop_id, stage, signals from leads").all()).toMatchObject({
      results: [
        { id: "l1", workspace_id: "demo", prop_id: "237487", stage: "contacted", signals: '{"roof_age_years":22}' },
      ],
    });
    const events = await db.prepare("select id, lead_id, kind, detail from lead_events order by id").all();
    expect(events.results).toEqual([
      { id: 1, lead_id: "l1", kind: "created", detail: "Created" },
      { id: 2, lead_id: "l1", kind: "note", detail: "Called owner" },
    ]);
    // The same property can now be a lead in another workspace, but not twice in one.
    await db.prepare("insert into workspaces (id, name, created_at, key_hash) values ('ws_x', 'X', 't', 'h')").run();
    const ins = (id: string, ws: string) =>
      db
        .prepare(
          "insert into leads (id, workspace_id, prop_id, address, source, source_run_id, created_at, updated_at) values (?, ?, '237487', 'a', 'finder', 'r', 't', 't')",
        )
        .bind(id, ws)
        .run();
    await ins("l2", "ws_x");
    await expect(ins("l3", "ws_x")).rejects.toThrow(/UNIQUE/);
    // New events continue after the restored ids; deleting a lead still cascades to its events.
    await db.prepare("insert into lead_events (lead_id, at, kind, detail) values ('l1', 't3', 'note', 'n')").run();
    expect(await db.prepare("select max(id) as id from lead_events").first()).toEqual({ id: 3 });
    await db.prepare("delete from leads where id = 'l1'").run();
    expect(await db.prepare("select count(*) as n from lead_events").first()).toEqual({ n: 0 });
  });
});
