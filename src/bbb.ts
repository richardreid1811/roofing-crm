// Client cache of rep-recorded BBB ratings, keyed by pipeline contractor key. Search results are
// merged with it so the table, the property panel and the assistant all see recorded ratings.
import type { BbbRating } from "../shared/bbb";
import type { Row } from "../shared/tools";
import { api } from "./api";

const cache = new Map<string, BbbRating | null>();
const BATCH = 200;

export const recordedRating = (key: unknown): BbbRating | null =>
  typeof key === "string" ? (cache.get(key) ?? null) : null;

export function setRecorded(key: string, rating: BbbRating | null) {
  cache.set(key, rating);
}

export async function loadRatings(keys: string[]): Promise<void> {
  const missing = [...new Set(keys)].filter((k) => k.startsWith("contractor:") && !cache.has(k));
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const { ratings } = await api.bbbRatings(chunk);
    for (const k of chunk) cache.set(k, ratings[k] ?? null);
  }
}

/** Add bbb_rating_recorded / bbb_recorded_at to rows whose contractor has a rep-recorded rating. */
export async function withRecordedRatings(rows: Row[]): Promise<Row[]> {
  const keys = rows.map((r) => r.contractor_key).filter((k): k is string => typeof k === "string");
  if (!keys.length) return rows;
  try {
    await loadRatings(keys);
  } catch {
    return rows; // ratings are an enrichment; searches never fail because of them
  }
  return rows.map((r) => {
    const rec = recordedRating(r.contractor_key);
    return rec ? { ...r, bbb_rating_recorded: rec.rating, bbb_recorded_at: rec.recorded_at.slice(0, 10) } : r;
  });
}
