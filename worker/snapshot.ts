// Points the UI at the latest published Travis County snapshot. The data itself is never proxied:
// the browser reads the Parquet tables from public IPFS gateways by CID. Sync call with a timeout;
// on failure the last good pointer is served (stale) so the CRM keeps working.
export const GATEWAYS = [
  "https://ipfs.filebase.io",
  "https://gateway.pinata.cloud",
  "https://ipfs.orbitor.dev",
  "https://dget.top",
];
export const TABLES = ["leads", "roofing_permits", "contractors", "hail_events", "permit_embeddings"] as const;
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;
/** After a failed refresh, serve the stale pointer at once for this long before trying the sources again. */
export const RETRY_MS = 60_000;

export type Snapshot = {
  run_id: string;
  published_at: string;
  manifest_cid: string;
  root_cid: string;
  tables: Record<string, { cid: string; size: number }>;
  counts: Record<string, string>;
  gateways: string[];
  history_url: string;
  stale?: boolean;
};

type History = { runs: { run_id: string; published_at: string; manifest_cid: string | null; root_cid: string }[] };
type Manifest = {
  run_id: string;
  root: { cid: string };
  objects: { name: string; cid: string; size: number }[];
  counts: Record<string, string>;
};

let cached: { at: number; value: Snapshot; stale?: boolean } | null = null;

async function getJson<T>(url: string, fetcher: typeof fetch): Promise<T> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function loadSnapshot(historyUrl: string, fetcher: typeof fetch = fetch): Promise<Snapshot> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.stale ? { ...cached.value, stale: true } : cached.value;
  try {
    const history = await getJson<History>(historyUrl, fetcher);
    const run = [...history.runs].reverse().find((r) => r.manifest_cid);
    if (!run?.manifest_cid) throw new Error("history has no published manifest");
    let manifest: Manifest | null = null;
    let lastError: unknown;
    for (const g of GATEWAYS) {
      try {
        manifest = await getJson<Manifest>(`${g}/ipfs/${run.manifest_cid}`, fetcher);
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!manifest) throw lastError instanceof Error ? lastError : new Error("no gateway served the manifest");
    const tables: Snapshot["tables"] = {};
    for (const t of TABLES) {
      const obj = manifest.objects.find((o) => o.name === `tables/${t}.parquet`);
      if (obj) tables[t] = { cid: obj.cid, size: obj.size };
    }
    for (const t of ["leads", "roofing_permits", "contractors"])
      if (!tables[t]) throw new Error(`manifest ${run.manifest_cid} has no tables/${t}.parquet`);
    const value: Snapshot = {
      run_id: manifest.run_id,
      published_at: run.published_at,
      manifest_cid: run.manifest_cid,
      root_cid: manifest.root.cid,
      tables,
      counts: manifest.counts,
      gateways: GATEWAYS,
      history_url: historyUrl,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch (e) {
    if (cached) {
      // Back off: without this, every request during an outage would wait out the full fetch sequence.
      cached = { at: Date.now() - TTL_MS + RETRY_MS, value: cached.value, stale: true };
      return { ...cached.value, stale: true };
    }
    throw e;
  }
}

/** Test hook. */
export const resetSnapshotCache = () => {
  cached = null;
};
