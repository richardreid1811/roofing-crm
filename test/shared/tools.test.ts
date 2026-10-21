import { asSchema } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { propertyPermitsSql, runTool, tools, type Run } from "../../shared/tools";
import { CENTER, fixture, n } from "./fixture";

let run: Run;
beforeAll(async () => {
  run = await fixture();
});
const at = { latitude: CENTER.lat, longitude: CENTER.lon, radius_miles: 5 };
const ids = (rows: { prop_id?: unknown }[]) => rows.map((r) => String(r.prop_id)).sort();

describe("find_leads", () => {
  it("matches any enabled criterion inside the radius, strictly older than the threshold", async () => {
    const res = await runTool("find_leads", { ...at, roof_older_than_years: 15, open_permit_min_years: 0 }, run);
    expect(ids(res.rows)).toEqual(["1", "2", "3"]);
    expect(n(res.count?.matches)).toBe(3);
    expect(n(res.count?.aged_roof)).toBe(2);
    expect(n(res.count?.open_permit)).toBe(2);
  });

  it("requires every criterion with match=all", async () => {
    const res = await runTool(
      "find_leads",
      { ...at, roof_older_than_years: 15, open_permit_min_years: 0, match: "all" },
      run,
    );
    expect(ids(res.rows)).toEqual(["3"]);
  });

  it("filters permits by open duration and status, ignoring closed and non-roof-work permits", async () => {
    expect(ids((await runTool("find_leads", { ...at, open_permit_min_years: 5 }, run)).rows)).toEqual(["2"]);
    expect(
      ids(
        (await runTool("find_leads", { ...at, open_permit_min_years: 0, permit_statuses: ["expired_unfinaled"] }, run))
          .rows,
      ),
    ).toEqual(["3"]);
    expect(ids((await runTool("find_leads", { ...at, open_permit_min_years: 0 }, run)).rows)).not.toContain("6");
  });

  it("finds hail since the roof and ranks multi-signal properties first", async () => {
    expect(ids((await runTool("find_leads", { ...at, hail_since_roof: true }, run)).rows)).toEqual(["3"]);
    const res = await runTool(
      "find_leads",
      { ...at, roof_older_than_years: 15, open_permit_min_years: 0, hail_since_roof: true },
      run,
    );
    expect(String(res.rows[0].prop_id)).toBe("3");
    expect(res.rows[0]).toMatchObject({ signal_aged_roof: true, signal_open_permit: true, signal_hail: true });
  });

  it("returns the oldest open permit with contractor, registry identity and a BBB lookup link", async () => {
    const res = await runTool("find_leads", { ...at, open_permit_min_years: 5 }, run);
    expect(res.rows[0]).toMatchObject({
      oldest_open_permit: "2017-001 BP",
      oldest_open_contractor: "ACME ROOFING",
      contractor_legal_name: "ACME ROOFING LLC",
      contractor_identity: "resolved_exact_name",
      bbb_rating: null,
    });
    expect(n(res.rows[0].oldest_open_years)).toBeGreaterThanOrEqual(6.9);
    expect(String(res.rows[0].bbb_lookup_url)).toContain("find_text=ACME%20ROOFING");
    expect(res.rows[0].contractor_key).toBe("k_ACME_ROOFING");
  });

  it("supports residential-only and a radius that excludes far properties", async () => {
    const res = await runTool("find_leads", { ...at, roof_older_than_years: 15, residential_only: true }, run);
    expect(ids(res.rows)).toEqual(["1"]);
    const wide = await runTool("find_leads", { ...at, radius_miles: 12, roof_older_than_years: 15 }, run);
    expect(ids(wide.rows)).toContain("4");
  });

  it("rejects calls without criteria or outside Travis County", async () => {
    await expect(runTool("find_leads", at, run)).rejects.toThrow(/at least one lead criterion/);
    await expect(
      runTool("find_leads", { latitude: 25.76, longitude: -80.19, roof_older_than_years: 15 }, run),
    ).rejects.toThrow(/outside the Travis County area/);
  });

  it("coerces the string and empty values language models send", async () => {
    const res = await runTool(
      "find_leads",
      {
        place: "Downtown Austin",
        latitude: "",
        longitude: "",
        radius_miles: "5",
        roof_older_than_years: "15",
        hail_since_roof: "false",
        limit: "10",
      },
      run,
    );
    expect(ids(res.rows)).toEqual(["1", "3"]);
    expect(res.resolvedPlace).toMatchObject({ name: "Downtown Austin" });
  });
});

describe("single-signal tools", () => {
  it("aged_roofs_near is strict and ranks permit-verified roofs first", async () => {
    const res = await runTool("aged_roofs_near", { ...at, older_than_years: 15 }, run);
    expect(ids(res.rows)).toEqual(["1", "3"]);
    expect(String(res.rows[0].prop_id)).toBe("3");
  });

  it("open_roofing_permits_near returns long-open roof work with years open", async () => {
    const res = await runTool("open_roofing_permits_near", { ...at, min_open_years: "5" }, run);
    expect(res.rows.map((r) => r.permit_number)).toEqual(["2017-001 BP"]);
    expect(n(res.count?.matches)).toBe(1);
  });

  it("hail_exposed_roofs_near ignores hail before the roof year", async () => {
    const res = await runTool("hail_exposed_roofs_near", { ...at, since: "1980-01-01" }, run);
    // The 40-year-old report at the center predates every roof; the recent one is within 1 mile of 2, 3 and 5.
    expect(ids(res.rows)).toEqual(["2", "3", "5"]);
    expect(ids(res.rows)).not.toContain("1");
    expect(res.rows.every((r) => n(r.hail_reports) === 1)).toBe(true);
  });

  it("resolves neighborhoods, strips modifiers and is safe against quotes", async () => {
    const res = await runTool("open_roofing_permits_near", { place: "near Downtown Austin", radius_miles: 2 }, run);
    expect(res.resolvedPlace).toMatchObject({ name: "Downtown Austin" });
    await expect(runTool("aged_roofs_near", { place: "x' or 1=1 --" }, run)).rejects.toThrow(/no Travis County place/);
  });

  it("property permits carry open duration and status", async () => {
    const rows = await run(propertyPermitsSql("6"));
    expect(rows).toHaveLength(2);
    const closed = rows.find((r) => r.status_bucket === "closed");
    expect(closed?.is_open).toBe(false);
    expect(n(closed?.duration_days)).toBeGreaterThan(700);
  });

  it("every tool exposes a JSON Schema the model can call", async () => {
    for (const t of tools) {
      const schema = (await asSchema(t.schema).jsonSchema) as { type?: string; properties?: object };
      expect(schema.type, t.name).toBe("object");
      expect(Object.keys(schema.properties ?? {}).length, t.name).toBeGreaterThan(0);
    }
  });
});
