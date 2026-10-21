// DuckDB-WASM over IPFS: the published Parquet tables are fetched by CID from public gateways and
// queried in the browser. The CRM consumes the pipeline's snapshot; it does not ingest data.
import * as duckdb from "@duckdb/duckdb-wasm";
import { PLACES_SQL, runTool as runSharedTool, type Row, type ToolResult } from "../shared/tools";
import type { Snapshot } from "./api";
import { withRecordedRatings } from "./bbb";
import { embedQuery } from "./embed";

export type LoadStep = { table: string; cid: string; gateway: string; ms: number; rows: number };
const EAGER = ["leads", "roofing_permits", "contractors", "hail_events"] as const;

let conn: duckdb.AsyncDuckDBConnection | null = null;
let db: duckdb.AsyncDuckDB | null = null;
let snap: Snapshot | null = null;

async function pickGateway(cid: string, gateways: string[]): Promise<string> {
  for (const g of gateways) {
    try {
      const res = await fetch(`${g}/ipfs/${cid}`, {
        headers: { Range: "bytes=0-3" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return g;
    } catch {
      /* try the next gateway */
    }
  }
  throw new Error(`no public gateway could serve ${cid}`);
}

async function loadTable(table: string): Promise<LoadStep> {
  const t = snap!.tables[table];
  if (!t) throw new Error(`snapshot has no ${table} table`);
  const started = performance.now();
  const gateway = await pickGateway(t.cid, snap!.gateways);
  await db!.registerFileURL(`${table}.parquet`, `${gateway}/ipfs/${t.cid}`, duckdb.DuckDBDataProtocol.HTTP, false);
  await conn!.query(`create or replace table ${table} as select * from read_parquet('${table}.parquet')`);
  const rows = Number((await query(`select count(*) as n from ${table}`))[0].n);
  return { table, cid: t.cid, gateway, ms: Math.round(performance.now() - started), rows };
}

export async function initDb(snapshot: Snapshot, onStep: (s: LoadStep) => void): Promise<void> {
  snap = snapshot;
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  for (const table of EAGER) if (snapshot.tables[table]) onStep(await loadTable(table));
  await conn.query(PLACES_SQL);
}

const plain = (v: unknown): unknown => {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object" && "toJSON" in v && typeof (v as { toJSON: unknown }).toJSON === "function")
    return plain((v as { toJSON: () => unknown }).toJSON());
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

export async function query(sql: string): Promise<Row[]> {
  if (!conn) throw new Error("data is still loading");
  const table = await conn.query(sql);
  const dateCols = new Set(table.schema.fields.filter((f) => String(f.type).startsWith("Date")).map((f) => f.name));
  return table.toArray().map((r) => {
    const obj = plain(r.toJSON()) as Row;
    for (const c of dateCols)
      if (typeof obj[c] === "number") obj[c] = new Date(obj[c] as number).toISOString().slice(0, 10);
    return obj;
  });
}

// Semantic retrieval: the embedding table loads on first use.
let embeddings: Promise<LoadStep> | null = null;

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  if (name === "semantic_search_permits") {
    embeddings ??= loadTable("permit_embeddings");
    await embeddings;
  }
  const res = await runSharedTool(name, args, query, embedQuery);
  return { ...res, rows: await withRecordedRatings(res.rows) };
}
