// Travis Roofing CRM Worker (Cloudflare free plan): static UI, lead records in D1, the snapshot
// pointer and the agent relay to Workers AI. No property data is stored or proxied here.
import { Hono } from "hono";
import { agentStep, AgentError, MODEL, validateChat } from "./agent";
import { bbb } from "./bbb";
import type { AppEnv } from "./env";
import { leads } from "./leads";
import { limited } from "./limits";
import { loadSnapshot } from "./snapshot";

export const app = new Hono<AppEnv>().basePath("/api");

app.get("/health", (c) => c.json({ ok: true, model: MODEL }));

app.get("/snapshot", async (c) => {
  try {
    const snap = await loadSnapshot(c.env.SNAPSHOT_HISTORY_URL);
    return c.json(snap, 200, { "cache-control": "public, max-age=60" });
  } catch (e) {
    console.error(JSON.stringify({ event: "snapshot_failed", error: String((e as Error).message ?? e) }));
    return c.json(
      { error: "snapshot_unavailable", message: "Could not reach the published snapshot. Try again shortly." },
      503,
    );
  }
});

app.route("/leads", leads);
app.route("/bbb", bbb);

app.post("/chat", async (c) => {
  if (limited(`ai:${c.req.header("cf-connecting-ip") ?? "local"}`, 20))
    return c.json({ error: "rate_limited", message: "Too many requests; wait a minute." }, 429);
  const v = validateChat(await c.req.json().catch(() => null));
  if (!v.ok) return c.json({ error: "bad_request", message: v.message }, 400);
  try {
    return c.json(await agentStep(c.env, v.data));
  } catch (e) {
    if (e instanceof AgentError) {
      console.error(JSON.stringify({ event: "agent_failed", code: e.code }));
      return c.json({ error: e.code, message: e.message }, e.status as 502 | 503 | 504);
    }
    throw e;
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled", path: c.req.path, error: String(err.message ?? err) }));
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;
