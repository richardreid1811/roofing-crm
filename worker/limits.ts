// Best-effort per-isolate rate limiter (sliding one-minute window). Workers AI's daily free
// allocation and the D1 free-plan limits are the hard caps; this only stops a single client from
// exhausting them.
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
