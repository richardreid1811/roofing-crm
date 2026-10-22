import { describe, expect, it } from "vitest";
import { permitStatusLabel, roofAgeText, sortRows } from "../../shared/display";
import { DEFAULT_FINDER_STATE, parseFinderState } from "../../shared/finder-state";

describe("permit status label", () => {
  it("shows the bucket once, with the source status only when it adds information", () => {
    expect(permitStatusLabel("Expired", "expired_unfinaled")).toBe("Expired, never finaled");
    expect(permitStatusLabel("Active", "open")).toBe("Open");
    expect(permitStatusLabel("Suspended", "open")).toBe("Open (Suspended)");
    expect(permitStatusLabel("Final", "closed")).toBe("Closed");
    expect(permitStatusLabel("Expired", "closed")).toBe("Closed (Expired)");
    expect(permitStatusLabel("VOID", "void")).toBe("Void / cancelled");
    expect(permitStatusLabel("Withdrawn", "void")).toBe("Void / cancelled (Withdrawn)");
  });

  it("infers the bucket of a saved lead's open permit from its source status", () => {
    expect(permitStatusLabel("Expired", null, true)).toBe("Expired, never finaled");
    expect(permitStatusLabel("Active", undefined, true)).toBe("Open");
    expect(permitStatusLabel("On Hold", undefined, true)).toBe("Open (On Hold)");
    expect(permitStatusLabel(null, undefined, true)).toBe("—");
  });
});

describe("roof age text", () => {
  const yb = "tcad_year_built_assumes_original_roof";
  it("caps year-built estimates past 40 years and names the year built", () => {
    expect(roofAgeText({ roof_age_years: 111, roof_age_basis: yb, year_built: 1915, roof_year: 1915 })).toBe(
      "≥ 40 yrs (built 1915)",
    );
    expect(roofAgeText({ roof_age_years: 30, roof_age_basis: yb, year_built: 1996 })).toBe("30 yrs");
    expect(roofAgeText({ roof_age_years: 45, roof_age_basis: "permit_final_roof_replacement" })).toBe("45 yrs");
    expect(roofAgeText({ roof_age_years: 41, roof_age_basis: yb, roof_year: 1985 })).toBe("≥ 40 yrs (built 1985)");
    expect(roofAgeText({ roof_age_years: null })).toBe("—");
  });
});

describe("finder sort", () => {
  const rows = [
    { prop_id: "a", roof_age_years: 111, roof_age_confidence: "very_low", distance_miles: 0.2, lead_score: 20 },
    { prop_id: "b", roof_age_years: 25, roof_age_confidence: "high", distance_miles: 1.1, lead_score: 25 },
    { prop_id: "c", roof_age_years: 35, roof_age_confidence: "low", distance_miles: 0.5, lead_score: 25 },
    { prop_id: "d", roof_age_years: null, roof_age_confidence: "none", distance_miles: 0.1, lead_score: 50 },
  ];
  const ids = (rs: { prop_id?: unknown }[]) => rs.map((r) => r.prop_id);
  it("ranks very-low-confidence roof ages below better evidence", () => {
    expect(ids(sortRows(rows, "roof_age_years"))).toEqual(["c", "b", "d", "a"]);
  });
  it("sorts distance ascending and keeps query order on ties", () => {
    expect(ids(sortRows(rows, "distance_miles"))).toEqual(["d", "a", "c", "b"]);
    expect(ids(sortRows(rows, "lead_score"))).toEqual(["d", "b", "c", "a"]);
  });
});

describe("finder state", () => {
  it("round-trips a stored search", () => {
    const s = {
      center: { lat: 30.3366, lon: -97.7462, label: "Allandale" },
      filters: { ...DEFAULT_FINDER_STATE.filters, radius: 3, ageOn: false, permitYears: 5, match: "all" },
      sort: "oldest_open_years",
      place: "Allandale",
    };
    expect(parseFinderState(JSON.stringify(s))).toEqual(s);
  });
  it("falls back to defaults for bad, partial or out-of-county state", () => {
    expect(parseFinderState(null)).toEqual(DEFAULT_FINDER_STATE);
    expect(parseFinderState("{not json")).toEqual(DEFAULT_FINDER_STATE);
    const s = parseFinderState(
      JSON.stringify({
        center: { lat: 30.6327, lon: -97.6779 },
        filters: { radius: 99, age: "x", match: "some" },
        sort: "evil",
      }),
    );
    expect(s).toEqual(DEFAULT_FINDER_STATE);
  });
});
