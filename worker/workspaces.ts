// Workspaces as capability links. POST /api/workspaces returns a random secret key once; only its SHA-256
// hash is stored. Requests carry the key in the x-workspace-key header and are scoped to that workspace;
// no header means the public demo workspace, which reviewers use without any login.
import { Hono, type MiddlewareHandler } from "hono";
import {
  createWorkspaceSchema,
  DEMO_WORKSPACE_ID,
  DEMO_WORKSPACE_NAME,
  WORKSPACE_HEADER,
  WORKSPACE_KEY_RE,
  type Workspace,
} from "../shared/workspaces";
import type { AppEnv } from "./env";
import { overLimit, WRITE_LIMIT_PER_MINUTE } from "./limits";

// Bounds the free-plan database: at most this many private workspaces, each capped at MAX_LEADS.
export const MAX_WORKSPACES = 500;
export const CREATE_LIMIT_PER_HOUR = 10;

const ip = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("cf-connecting-ip") ?? "local";

// A 256-bit random key needs no slow password hash: SHA-256 cannot be brute-forced from the stored hash.
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `wsk_${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

/** Resolves x-workspace-key to a workspace id (one D1 read); no header means the demo workspace. */
export const resolveWorkspace: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(WORKSPACE_HEADER)?.trim();
  if (!key) {
    c.set("workspace", DEMO_WORKSPACE_ID);
    return next();
  }
  const row = WORKSPACE_KEY_RE.test(key)
    ? await c.env.DB.prepare("select id from workspaces where key_hash = ?")
        .bind(await sha256Hex(key))
        .first<{ id: string }>()
    : null;
  if (!row)
    return c.json(
      { error: "unknown_workspace", message: "This workspace link is not valid (it may have been deleted)." },
      401,
    );
  c.set("workspace", row.id);
  return next();
};

/** Durable write limit per client IP and workspace (shared by leads, BBB ratings and workspaces). */
export const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && (await overLimit(c.env.DB, `w:${ip(c)}:${c.get("workspace")}`, WRITE_LIMIT_PER_MINUTE)))
    return c.json({ error: "rate_limited", message: "Too many changes; wait a minute." }, 429);
  return next();
};

export const workspaces = new Hono<AppEnv>();

workspaces.post("/", async (c) => {
  if (await overLimit(c.env.DB, `ws-create:${ip(c)}`, CREATE_LIMIT_PER_HOUR, { windowSeconds: 3600 }))
    return c.json({ error: "rate_limited", message: "Too many workspaces created; try again later." }, 429);
  const parsed = createWorkspaceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const total = await c.env.DB.prepare("select count(*) as n from workspaces where key_hash is not null").first<{
    n: number;
  }>();
  if ((total?.n ?? 0) >= MAX_WORKSPACES)
    return c.json({ error: "full", message: "No more private workspaces can be created on this demo." }, 409);
  const key = newKey();
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await c.env.DB.prepare("insert into workspaces (id, name, created_at, key_hash) values (?, ?, ?, ?)")
    .bind(id, parsed.data.name, new Date().toISOString(), await sha256Hex(key))
    .run();
  // The key is returned once and never stored; losing it means losing access to the workspace.
  return c.json({ workspace: { id, name: parsed.data.name, public: false } satisfies Workspace, key }, 201);
});

workspaces.use("/self", resolveWorkspace, limitWrites);

workspaces.get("/self", async (c) => {
  const id = c.get("workspace");
  if (id === DEMO_WORKSPACE_ID)
    return c.json({ workspace: { id, name: DEMO_WORKSPACE_NAME, public: true } satisfies Workspace });
  const row = await c.env.DB.prepare("select id, name from workspaces where id = ?").bind(id).first<Workspace>();
  return c.json({ workspace: { id, name: row?.name ?? "", public: false } satisfies Workspace });
});

// Deletes the workspace named by the key, with all its leads and their activity. The demo cannot be deleted.
workspaces.delete("/self", async (c) => {
  const id = c.get("workspace");
  if (id === DEMO_WORKSPACE_ID)
    return c.json({ error: "forbidden", message: "The public demo workspace cannot be deleted." }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("delete from lead_events where lead_id in (select id from leads where workspace_id = ?)").bind(id),
    c.env.DB.prepare("delete from leads where workspace_id = ?").bind(id),
    c.env.DB.prepare("delete from workspaces where id = ?").bind(id),
  ]);
  return c.body(null, 204);
});
