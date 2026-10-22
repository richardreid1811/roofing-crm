import { beforeAll, describe, expect, it } from "vitest";
import { runTool, type Run } from "../../shared/tools";
import { CENTER, fixture, n } from "./fixture";

// Own fixture: adds two long-open permits so the 10-year score cap produces a tie.
let run: Run;
beforeAll(async () => {
  run = await fixture();
  // 7 is farther than 8 but its permit has been open longer.
  for (const [id, lat, years] of [
    ["7", CENTER.lat - 2 / 69, 18],
    ["8", CENTER.lat - 1.5 / 69, 11],
  ] as const) {
    await run(
      `insert into leads select * replace ('${id}' as prop_id, ${lat} as latitude) from leads where prop_id = '2'`,
    );
    await run(`insert into roofing_permits select * replace ('austin:L${id}' as permit_key, 'L${id}' as permit_number,
      '${id}' as prop_id, ${lat} as latitude, current_date - interval ${years} year as opened_date)
      from roofing_permits where permit_number = '2017-001 BP'`);
  }
});
const at = { latitude: CENTER.lat, longitude: CENTER.lon, radius_miles: 5 };

describe("long-open permit ranking", () => {
  it("breaks capped-score ties by years open, not distance", async () => {
    const res = await runTool("find_leads", { ...at, open_permit_min_years: 5 }, run);
    expect(res.rows.map((r) => String(r.prop_id))).toEqual(["7", "8", "2"]);
    expect(n(res.rows[0].lead_score)).toBe(n(res.rows[1].lead_score));
    expect(n(res.rows[0].oldest_open_years)).toBeGreaterThan(n(res.rows[1].oldest_open_years));
    expect(res.rows[0].oldest_open_status_bucket).toBe("open");
  });
});

describe("minimum roof-age confidence", () => {
  it("only counts aged roofs with evidence at least that confident", async () => {
    const any = await runTool("find_leads", { ...at, roof_older_than_years: 15 }, run);
    expect(any.rows.map((r) => String(r.prop_id)).sort()).toEqual(["1", "3"]);
    const medium = await runTool(
      "find_leads",
      { ...at, roof_older_than_years: 15, min_roof_age_confidence: "medium" },
      run,
    );
    expect(medium.rows.map((r) => String(r.prop_id))).toEqual(["3"]);
    const either = await runTool(
      "find_leads",
      { ...at, roof_older_than_years: 15, open_permit_min_years: 5, min_roof_age_confidence: "medium" },
      run,
    );
    const p1 = either.rows.find((r) => String(r.prop_id) === "1");
    expect(p1).toBeUndefined();
  });
});
