import { beforeEach, describe, expect, it } from "vitest";
import { loadSnapshot, resetSnapshotCache, RETRY_MS } from "../../worker/snapshot";

const HISTORY = "https://example.test/history.json";
const history = {
  runs: [{ run_id: "r1", published_at: "2026-10-20T00:00:00Z", manifest_cid: "bafymanifest", root_cid: "bafyroot" }],
};
const manifest = {
  run_id: "r1",
  root: { cid: "bafyroot" },
  counts: { properties: "441972" },
  objects: ["leads", "roofing_permits", "contractors", "hail_events"].map((t) => ({
    name: `tables/${t}.parquet`,
    cid: `cid-${t}`,
    size: 10,
  })),
};

function fakeFetch(failGateways = 0, failAll = false) {
  let gatewayCalls = 0;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (failAll) throw new Error("network down");
    if (url === HISTORY) return Response.json(history);
    if (url.endsWith("/ipfs/bafymanifest")) {
      gatewayCalls++;
      return gatewayCalls <= failGateways ? new Response("bad gateway", { status: 502 }) : Response.json(manifest);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("snapshot pointer", () => {
  beforeEach(resetSnapshotCache);

  it("resolves the latest run's tables from its manifest, falling back across gateways", async () => {
    const snap = await loadSnapshot(HISTORY, fakeFetch(2));
    expect(snap.run_id).toBe("r1");
    expect(snap.tables.leads.cid).toBe("cid-leads");
    expect(snap.tables.permit_embeddings).toBeUndefined();
  });

  it("serves the last good snapshot (stale) when sources are unreachable", async () => {
    await loadSnapshot(HISTORY, fakeFetch());
    // Expire the cache by faking time.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      const snap = await loadSnapshot(HISTORY, fakeFetch(0, true));
      expect(snap.stale).toBe(true);
      expect(snap.run_id).toBe("r1");
    } finally {
      Date.now = realNow;
    }
  });

  it("after a failed refresh, serves the stale snapshot without refetching until the retry backoff ends", async () => {
    await loadSnapshot(HISTORY, fakeFetch());
    const realNow = Date.now;
    const t0 = realNow() + 10 * 60_000;
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new Error("network down");
    }) as typeof fetch;
    try {
      Date.now = () => t0;
      expect((await loadSnapshot(HISTORY, down)).stale).toBe(true);
      const tried = calls;
      Date.now = () => t0 + RETRY_MS - 1000;
      expect((await loadSnapshot(HISTORY, down)).stale).toBe(true);
      expect(calls).toBe(tried); // served from the backoff, no fetch
      Date.now = () => t0 + RETRY_MS + 1000;
      expect((await loadSnapshot(HISTORY, down)).stale).toBe(true);
      expect(calls).toBeGreaterThan(tried); // backoff over: the sources are tried again
      Date.now = () => t0 + 2 * RETRY_MS + 2000;
      expect((await loadSnapshot(HISTORY, fakeFetch())).stale).toBeUndefined(); // recovered
    } finally {
      Date.now = realNow;
    }
  });

  it("fails clearly when there is no snapshot at all", async () => {
    await expect(loadSnapshot(HISTORY, fakeFetch(0, true))).rejects.toThrow(/network down/);
  });
});
