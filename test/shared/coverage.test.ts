import { beforeAll, describe, expect, it } from "vitest";
import { coverageNote, coverageNoteFor } from "../../shared/coverage";
import { runTool, type Row, type Run } from "../../shared/tools";
import { CENTER, fixture, n } from "./fixture";

let run: Run;
beforeAll(async () => {
  run = await fixture();
});

describe("coverage note", () => {
  it("says nothing when the searched area has permit history", async () => {
    const args = { latitude: CENTER.lat, longitude: CENTER.lon, radius_miles: 5 };
    expect(await coverageNoteFor("open_roofing_permits_near", args, [], run)).toBeUndefined();
  });

  it("names Pflugerville and unincorporated land with the uncovered share", async () => {
    const stub: Run = async () => [
      { coverage: "municipal_permits_not_yet_ingested", jurisdiction: "CITY OF PFLUGERVILLE", n: 500 },
      { coverage: "no_county_building_permits_in_texas", jurisdiction: "TRAVIS COUNTY", n: 120 },
      { coverage: "austin_permit_history_1978_plus", jurisdiction: "CITY OF AUSTIN", n: 300 },
      { coverage: "austin_etj_or_limited_purpose_permits", jurisdiction: "AUSTIN ETJ", n: 80 },
    ];
    const note = await coverageNoteFor(
      "open_roofing_permits_near",
      { latitude: 30.44, longitude: -97.62, radius_miles: 5 },
      [],
      stub,
    );
    expect(note).toBe(
      "62% of properties in this area are in jurisdictions whose permits are not in the data (Pflugerville requires a portal login; unincorporated county land has no building permits), so open-permit results here are incomplete.",
    );
  });

  it("ignores small gaps and treats Lakeway permit history as covered", () => {
    expect(
      coverageNote(
        [
          { coverage: "austin_permit_history_1978_plus", jurisdiction: "CITY OF AUSTIN", n: 95 },
          { coverage: "no_county_building_permits_in_texas", jurisdiction: null, n: 5 },
        ],
        "find_leads",
      ),
    ).toBeUndefined();
    expect(
      coverageNote([{ coverage: "lakeway_permit_history", jurisdiction: "CITY OF LAKEWAY", n: 10 }], "find_leads"),
    ).toBeUndefined();
  });

  it("falls back to the returned rows when the tool had no search center", async () => {
    const rows: Row[] = [
      { prop_id: "1", permit_history_coverage: "municipal_permits_not_yet_ingested", jurisdiction: "CITY OF MANOR" },
      { prop_id: "2", permit_history_coverage: "austin_permit_history_1978_plus", jurisdiction: "CITY OF AUSTIN" },
    ];
    expect(await coverageNoteFor("property_detail", { prop_id: "1" }, rows, run)).toBe(
      "50% of the returned properties are in jurisdictions whose permits are not in the data (Manor permits are not ingested yet), so open-permit results here are incomplete.",
    );
    expect(await coverageNoteFor("semantic_search_permits", {}, [{ permit_number: "x" }], run)).toBeUndefined();
  });

  it("warns on a finder search over Pflugerville, where 0 open permits means no permit data", async () => {
    // Two Pflugerville properties with old roofs and no permit history, ~15 miles from downtown.
    await run(`insert into leads select * replace ('P' || prop_id as prop_id, 'CITY OF PFLUGERVILLE' as jurisdiction,
      'municipal_permits_not_yet_ingested' as permit_history_coverage, 30.44 as latitude, -97.62 as longitude)
      from leads where prop_id in ('1', '4')`);
    // Exactly what the Lead finder runs: find_leads, then the caveat over its searched area.
    const res = await runTool(
      "find_leads",
      { latitude: 30.44, longitude: -97.62, radius_miles: 1.5, roof_older_than_years: 15, open_permit_min_years: 0 },
      run,
    );
    expect(n(res.count?.matches)).toBe(2);
    expect(n(res.count?.open_permit)).toBe(0);
    expect(await coverageNoteFor("find_leads", res.args, res.rows, run)).toBe(
      "100% of properties in this area are in jurisdictions whose permits are not in the data (Pflugerville requires a portal login), so open-permit results here are incomplete.",
    );
    // Downtown Austin (full permit history) stays unannotated.
    const austin = await runTool("find_leads", { ...CENTER_ARGS, roof_older_than_years: 15 }, run);
    expect(await coverageNoteFor("find_leads", austin.args, austin.rows, run)).toBeUndefined();
  });
});

const CENTER_ARGS = { latitude: CENTER.lat, longitude: CENTER.lon, radius_miles: 1.5 };
