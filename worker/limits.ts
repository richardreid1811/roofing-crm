// Rate limiters. Workers AI's daily free allocation and the D1 free-plan limits are the hard caps; these
// only stop a single client from exhausting them.

// Write routes (leads, BBB ratings, workspaces): a durable fixed-window counter in D1, shared by every
// isolate and colo, so a client cannot reset it by landing on a fresh isolate. One D1 call per check: a
// single upsert ... returning, batched with the occasional cleanup of old windows.
export const WRITE_LIMIT_PER_MINUTE = 60;
// Old windows are removed on about 1 in CLEANUP_EVERY checks, keeping the longest window any caller uses.
const CLEANUP_EVERY = 50;
const RETAIN_SECONDS = 2 * 3600;

export async function overLimit(
  db: D1Database,
  key: string,
  max: number,
  opts: { windowSeconds?: number; now?: number; cleanup?: boolean } = {},
): Promise<boolean> {
  const windowSeconds = opts.windowSeconds ?? 60;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);
  const stmts = [
    db
      .prepare(
        `insert into rate_limits (key, window_start, count) values (?, ?, 1)
         on conflict (key, window_start) do update set count = count + 1 returning count`,
      )
      .bind(key, windowStart),
  ];
  if (opts.cleanup ?? Math.random() < 1 / CLEANUP_EVERY)
    stmts.push(db.prepare("delete from rate_limits where window_start < ?").bind(nowSeconds - RETAIN_SECONDS));
  try {
    const [res] = await db.batch<{ count: number }>(stmts);
    return (res.results[0]?.count ?? 0) > max;
  } catch (e) {
    // Fail open: if D1 is unavailable the write fails anyway; do not turn a blip into a 429.
    console.error(JSON.stringify({ event: "rate_limit_failed", error: String((e as Error).message ?? e) }));
    return false;
  }
}

// The chat route keeps a best-effort per-isolate limiter (sliding one-minute window). It guards the
// Workers AI allocation, which fails closed at its daily cap anyway, and costs no D1 call per message.
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

export function limited(key: string, maxPerMinute: number): boolean {
  const t = Date.now();
  const recent = (hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
  recent.push(t);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > maxPerMinute;
}
