import { beforeAll, describe, expect, it } from "vitest";
import { isAllowanceExhausted, parseQuestion, runFallback } from "../../shared/fallback";
import { runTool, type Row, type Run } from "../../shared/tools";
import { fixture, n } from "./fixture";

const TODAY = new Date("2026-10-21T12:00:00Z");
const plan = (q: string) => parseQuestion(q, TODAY);

describe("fallback question parser", () => {
  it("README prompt: open permits older than five years within five miles of a city", () => {
    expect(plan("show me open roofing permits older than five years within five miles of Rollingwood")).toMatchObject({
      tool: "open_roofing_permits_near",
      args: { radius_miles: 5, min_open_years: 5 },
      places: ["Rollingwood"],
    });
  });

  it("Pflugerville prompts", () => {
    expect(plan("Show me open roofing permits older than 5 years within 5 miles of Pflugerville")).toMatchObject({
      tool: "open_roofing_permits_near",
      args: { radius_miles: 5, min_open_years: 5 },
      places: ["Pflugerville"],
    });
    expect(plan("Which roofs in Pflugerville are older than 20 years?")).toMatchObject({
      tool: "aged_roofs_near",
      args: { radius_miles: 3, older_than_years: 20 },
      places: ["Pflugerville"],
    });
  });

  it("combined criteria go to find_leads with the roof threshold on roofs", () => {
    expect(
      plan("Which roofs older than 20 years within 1 mile of Hyde Park have an open roofing permit or hail damage?"),
    ).toMatchObject({
      tool: "find_leads",
      args: {
        radius_miles: 1,
        roof_older_than_years: 20,
        open_permit_min_years: 0,
        hail_since_roof: true,
        match: "any",
      },
      places: ["Hyde Park"],
    });
  });

  it("long-open permits default to 5 years and a 3-mile radius", () => {
    expect(plan("Find long-open roofing permits near downtown Austin and who the contractor is")).toMatchObject({
      tool: "open_roofing_permits_near",
      args: { radius_miles: 3, min_open_years: 5 },
      places: ["downtown Austin"],
    });
    expect(plan("permits open for more than 8 years in 78704").args).toMatchObject({ min_open_years: 8 });
    expect(plan("permits open for more than 8 years in 78704").places[0]).toBe("78704");
  });

  it("Allandale hail prompt: hail tool, since 3 years ago, place not confused with 'in the last'", () => {
    expect(plan("Which homes near Allandale were hit by large hail in the last 3 years?")).toEqual({
      tool: "hail_exposed_roofs_near",
      args: { radius_miles: 3, since: "2023-10-21", limit: 50 },
      places: ["Allandale"],
      summary: expect.stringContaining("hail"),
    });
  });

  it("aged roofs only, and anything else falls back to the lead search", () => {
    expect(plan("old roofs within half a mile of Zilker")).toMatchObject({
      tool: "aged_roofs_near",
      args: { radius_miles: 0.5, older_than_years: 15 },
      places: ["Zilker"],
    });
    expect(plan("good roofing leads around Mueller")).toMatchObject({
      tool: "find_leads",
      args: { radius_miles: 3, roof_older_than_years: 15, open_permit_min_years: 0 },
      places: ["Mueller"],
    });
  });
});

describe("allowance detection", () => {
  it("recognizes the Worker's simulated 503 ai_allocation_exhausted reply and nothing else", async () => {
    const reply = (status: number, error: string) =>
      new Response(JSON.stringify({ error, message: "…" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const check = async (res: Response) => isAllowanceExhausted(res.status, ((await res.json()) as Row).error);
    expect(await check(reply(503, "ai_allocation_exhausted"))).toBe(true);
    expect(await check(reply(503, "snapshot_unavailable"))).toBe(false);
    expect(await check(reply(504, "ai_timeout"))).toBe(false);
    expect(await check(reply(429, "rate_limited"))).toBe(false);
  });
});

describe("runFallback", () => {
  let run: Run;
  beforeAll(async () => {
    run = await fixture();
  });
  const exec = (tool: string, args: Row) => runTool(tool, args, run);

  it("runs the tool at the resolved place", async () => {
    const out = await runFallback(
      "open roofing permits older than five years within five miles of downtown Austin",
      exec,
      TODAY,
    );
    expect(out.place).toBe("Downtown Austin");
    expect(out.placeNote).toBeUndefined();
    expect(out.result.rows.map((r) => r.permit_number)).toEqual(["2017-001 BP"]);
    expect(out.result.sql).toContain("roofing_permits");
  });

  it("searches the default center and says so when no place is known", async () => {
    const out = await runFallback("roofs older than 15 years within 5 miles of Atlantis", exec, TODAY);
    expect(out.place).toBe("Downtown Austin");
    expect(out.placeNote).toMatch(/No Travis County place matches "Atlantis"/);
    expect(out.result.rows.length).toBeGreaterThan(0);
    expect(n(out.result.count?.matches)).toBe(out.result.rows.length);
  });
});
