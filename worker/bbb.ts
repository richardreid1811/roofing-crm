// Rep-recorded BBB ratings in D1. Read in batches by contractor key; every save adds a history entry.
import { Hono } from "hono";
import { z } from "zod";
import { bbbRatingInputSchema, contractorKeySchema, type BbbRating } from "../shared/bbb";
import type { AppEnv } from "./env";
import { limitWrites, resolveWorkspace } from "./workspaces";

type Row = Omit<BbbRating, "accredited"> & { accredited: number | null };
const toRating = (r: Row): BbbRating => ({ ...r, accredited: r.accredited === null ? null : r.accredited === 1 });
const MAX_KEYS = 200;

export const bbb = new Hono<AppEnv>();

// Ratings are global, not per workspace: a BBB rating is a public fact about a contractor, so every
// workspace (demo or private) sees the same entries. Writes still resolve the workspace key, so an unknown
// key is refused and the write limit applies per client and workspace.
bbb.on(["POST", "DELETE"], "*", resolveWorkspace, limitWrites);

// GET /api/bbb?keys=contractor:..,contractor:..  -> latest rating per key (keys without one are omitted)
bbb.get("/", async (c) => {
  const keys = [...new Set((c.req.query("keys") ?? "").split(",").filter(Boolean))];
  const parsed = z.array(contractorKeySchema).max(MAX_KEYS).safeParse(keys);
  if (!parsed.success) return c.json({ error: "invalid", message: `Up to ${MAX_KEYS} valid contractor keys.` }, 400);
  if (!keys.length) return c.json({ ratings: {} });
  const { results } = await c.env.DB.prepare(
    `select r.* from bbb_ratings r
     join (select contractor_key, max(id) as id from bbb_ratings
           where contractor_key in (${keys.map(() => "?").join(",")}) group by contractor_key) latest using (id)`,
  )
    .bind(...keys)
    .all<Row>();
  return c.json({ ratings: Object.fromEntries(results.map((r) => [r.contractor_key, toRating(r)])) });
});

// GET /api/bbb/:key -> history, newest first
bbb.get("/:key", async (c) => {
  const key = contractorKeySchema.safeParse(c.req.param("key"));
  if (!key.success) return c.json({ error: "invalid" }, 400);
  const { results } = await c.env.DB.prepare(
    "select * from bbb_ratings where contractor_key = ? order by id desc limit 50",
  )
    .bind(key.data)
    .all<Row>();
  return c.json({ history: results.map(toRating) });
});

bbb.post("/", async (c) => {
  const parsed = bbbRatingInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const r = parsed.data;
  const row = await c.env.DB.prepare(
    `insert into bbb_ratings (contractor_key, contractor_name, rating, accredited, profile_url, recorded_by, note, recorded_at)
     values (?, ?, ?, ?, ?, ?, ?, ?) returning *`,
  )
    .bind(
      r.contractor_key,
      r.contractor_name,
      r.rating,
      r.accredited === undefined || r.accredited === null ? null : r.accredited ? 1 : 0,
      r.profile_url ?? null,
      r.recorded_by ?? null,
      r.note ?? null,
      new Date().toISOString(),
    )
    .first<Row>();
  return c.json({ rating: toRating(row!) }, 201);
});

// Remove a mistaken entry; the previous entry (if any) becomes current again.
bbb.delete("/entries/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("delete from bbb_ratings where id = ?").bind(id).run();
  return c.body(null, 204);
});
