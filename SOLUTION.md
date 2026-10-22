# Travis County roofing CRM: solution

**Live app:** https://travis-roofing-crm.travis-oracle-web.workers.dev (no login, no credentials)

A map-based roofing lead CRM for Travis County, Texas. A rep drops a pin or uses GPS, sets a radius, and
sees properties with aged roofs, long-open roofing permits and severe hail since the roof. They can open a
property's permits with status, time open, contractor and BBB, save matches as lead records, and work
those leads through a pipeline. A natural-language assistant answers from the same records and can
save its results as leads.

Data comes from the separate Travis County Oracle pipeline
([repo](https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx),
[explorer](https://travis-oracle.travis-oracle-web.workers.dev)), which publishes a content-addressed
snapshot to IPFS. This repo does not gather or ingest data.

## How to review in 3 minutes

1. Open the app. The **Lead finder** loads Travis County data from IPFS (about 10 s on first load) and lists
   lead candidates within 1.5 miles of downtown Austin, ranked by lead score.
2. Click the map (or drag the pin, or use **Use my location** inside the county) and change the radius.
   The list and map update.
3. Turn criteria on and off: roof older than N years, open roofing permit open at least N years (open
   and/or expired-never-finaled), severe hail since the roof, match any/all, residential only.
   **Long-open permits only** is a one-click preset.
4. Click a row (or a map marker) to open the property: roof-age evidence, owner, hail, and every roofing
   permit with status, opened date, time open, contractor, Texas registry match and BBB.
5. Tick rows and **Save as leads**, or use **Save as lead** in the property panel.
6. **Leads**: stage tabs with counts, search, and a lead panel with stage, priority, assignee, next action,
   notes and an activity timeline. Records are stored in Cloudflare D1, so they persist across browsers.
7. **Assistant**: ask e.g. "Show me open roofing permits older than five years within five miles of
   Rollingwood". Each search shows its SQL and a result table you can save as leads.
8. **Coming soon** items in the navigation (and disabled buttons on a lead) show the planned expansion:
   outreach, estimates, jobs, insurance claims, canvassing routes and reports.

## Acceptance criteria → evidence

| Criterion                                                  | How it is met                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default to a county; explore the selected area             | Opens on Travis County (Census TIGER/Line county boundary drawn, default pin downtown Austin). Place search accepts cities, ZIPs and Austin neighborhoods; coordinates outside the county are rejected, not clamped                                                         |
| Center on GPS and/or a dropped pin                         | **Use my location** (browser geolocation, checked against the county) and click-to-drop or drag the pin                                                                                                                                                                     |
| Configurable radius                                        | Slider from 0.25 to 10 miles; the map fits the radius circle                                                                                                                                                                                                                |
| Roofs older than a configurable threshold (default 15)     | `Roof older than N years`, strictly older. Roof age comes from a finaled re-roof permit (high confidence), an unfinaled one (medium) or TCAD year built (low / very low), and the basis is shown on every row                                                               |
| Open roofing permits, emphasis on long-open                | `Open roofing permit, open at least N years` with status choice (open / expired without final inspection). Long-open permits add to the lead score (3 points per year, up to 10 years), the list sorts by years open, and markers for open permits are red                  |
| Permit details: status, age/open duration, contractor, BBB | Property panel and result rows: status and normalized bucket, opened/expires/completed dates, open duration, contractor, phone, Texas Comptroller registry match, and BBB rating where present (see BBB note)                                                               |
| Browsable list of candidates                               | Ranked, sortable table (score, roof age, years open, distance) with a count of all matches in the radius                                                                                                                                                                    |
| Create and manage CRM lead records                         | Bulk save from the finder or the assistant, or single save from a property. Leads have a stage pipeline, priority, assignee, next action and due date, notes and an activity timeline, plus delete. One lead per property; the evidence at creation is stored with the lead |
| RAG-backed agent                                           | Llama 3.3 70B on Workers AI via the Vercel AI SDK. Retrieval is tool calls that run as SQL over the snapshot, plus semantic search over permit-description embeddings. Answers are grounded in the returned rows, and the SQL and rows are shown                            |
| Data gathering out of scope                                | The app reads the pipeline's published Parquet tables by CID from public IPFS gateways (DuckDB-WASM in the browser). **About this data** (top bar) shows the snapshot, manifest CID, tables and gateways                                                                    |
| Disabled sections for future expansion                     | Six "Coming soon" sections in the navigation, each with a disabled preview page, plus disabled outreach, estimate and route actions on leads and properties                                                                                                                 |

**BBB.** BBB has no public API and blocks automated access, so the published dataset has no BBB ratings
(this README puts live BBB integration out of scope). The app never contacts BBB. Instead, wherever a
contractor appears (candidate list, property panel, assistant results, lead record) there is:

- **Check BBB ↗**: opens BBB's own search for that contractor in a new tab.
- **record / update**: the rep enters what BBB shows (rating, accreditation, profile link, note). It is stored
  in D1 per contractor (keyed by the pipeline's stable `contractor_key`, with history; the latest entry is
  current) and shown everywhere with a "rep-entered" tag and who/when on hover. Saved leads carry it in
  their evidence, and the assistant cites it as "entered by a rep from bbb.org on <date>".

## Architecture

```
Browser (React + Leaflet)                          Cloudflare Worker (free plan)
 ├─ DuckDB-WASM ◄── Parquet by CID ── IPFS gateways   ├─ /api/snapshot  latest run → table CIDs (cached, stale-on-error)
 │   find_leads / permits / hail / semantic SQL       ├─ /api/leads     CRUD + notes + activity  ──► D1 (SQLite)
 ├─ lead finder, property panel, leads, assistant     ├─ /api/chat      one agent step ──► Workers AI (AI SDK)
 └─ tool execution for the assistant                  └─ static assets
```

- **One tool contract** (`shared/tools.ts`): Zod schemas plus DuckDB SQL builders. The lead finder, the
  assistant (via AI SDK tool definitions) and the tests all use it. The model's tool inputs are validated
  and coerced against the same schemas before any SQL is built, and the SQL only interpolates validated
  values.
- **Agent loop**: the Worker runs one model step with tool definitions but no server-side execution. The
  browser runs the chosen tool over the snapshot and sends the rows back as tool results, and the model
  answers from them (answer mode withholds tools after one round, which keeps Llama from looping).
- **Lead records**: D1 with `leads` (one per TCAD property, unique) and `lead_events` (created, stage,
  update, note). Input is validated with the shared Zod contract (`shared/leads.ts`). The public demo
  workspace is capped at 5,000 leads and writes are rate-limited per client.

## Stack and kit guidelines

Following the Soofi team kit's engineering guidelines where they apply: TypeScript everywhere,
**Vercel AI SDK** for every LLM call with **Zod** tool schemas and no `any`, Vitest, ESLint, Prettier and tsc
in GitHub Actions CI, no secrets or PII in logs (structured JSON error events only), and a documented
timeout and recovery for the one synchronous external call (Workers AI: 30 s timeout, one retry, clear
messages for timeouts; when the daily allocation is exhausted the assistant runs a rule-based direct search
of the question instead, and search, map and leads keep working without it).

Deviations, all because the assignment requires zero ongoing infrastructure cost:

- **Cloudflare (Workers, D1, Workers AI) instead of AWS + CDK.** Free-plan resources with no card on file:
  usage beyond the free limits fails instead of billing.
- **No PagerDuty, CloudWatch or Powertools.** Workers observability logs are enabled; there is no on-call
  rotation for a take-home demo.
- **No queued boundary for the model call.** It is interactive chat, so it is synchronous with the timeout
  and recovery above. The snapshot pointer serves the last good value when the history or gateways are
  unreachable.

## Tests

`npm run check` = format check, lint, typecheck, tests, build (same as CI).

- `test/shared/tools.test.ts`: every tool's SQL against a fixture with the published column names in real
  DuckDB:
  - any/all matching
  - the strict age threshold
  - open-duration and status filters
  - closed and non-roof permits ignored
  - hail before the roof year ignored
  - ranking, radius and residential filters
  - out-of-county rejection
  - coercion of the string values models send
  - place resolution
  - quote safety
  - JSON Schema generation for every tool
- `test/shared/snapshot.test.ts`: latest-run resolution, gateway fallback, stale-on-error.
- `test/worker/api.test.ts`: the Worker in the Workers runtime with a real local D1:
  - lead creation and duplicate handling
  - validation (bad ids, out-of-county coordinates, non-https links, unknown fields)
  - stage changes, edits and notes on the timeline
  - list, filter and search
  - delete with activity cleanup
  - BBB ratings: history, latest-per-contractor batch reads, entry removal, and validation of contractor keys, ratings and bbb.org-only links
  - malformed chat requests rejected before the model is called

The tools were also run against the real published tables (442k properties): a combined lead search
within 1.5 miles of downtown returns in about 40 ms.

## Runbook

```bash
npm ci
npm run check                      # what CI runs
npx wrangler d1 migrations apply roofing-crm --local
npm run preview                    # build + wrangler dev on http://localhost:8787 (Workers AI runs remotely)
npm run deploy                     # build, apply D1 migrations remotely, deploy
```

The snapshot source is `SNAPSHOT_HISTORY_URL` in `wrangler.jsonc` (the pipeline's `runs/history.json`).
A new pipeline run is picked up within 5 minutes without redeploying.

## Known limitations

- **Permit coverage** is the City of Austin (about 56% of parcels, plus Austin ETJ permits). Unincorporated
  Travis County issues no building permits, and other cities' permits are not ingested yet. Outside Austin,
  roof age is the year-built estimate. The property panel says which applies.
- **BBB ratings** are not in the published data; they appear only once a rep records them (see above).
- **Shared demo workspace**: there is no login, so every visitor sees and edits the same leads. Auth and
  per-company workspaces would come before real use.
- **First load** downloads about 30 MB of Parquet from IPFS; later queries run locally in the browser. Semantic
  search downloads its embedding model and table on first use.
