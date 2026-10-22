import { describe, expect, it } from "vitest";
import { TRAVIS_BOUNDARY } from "../../shared/county-boundary";
import { COUNTY, inCounty, inRing, milesToRing } from "../../shared/tools";

describe("Travis County boundary", () => {
  it("is a small closed ring whose extent matches COUNTY.bounds", () => {
    expect(TRAVIS_BOUNDARY.length).toBeGreaterThan(100);
    expect(TRAVIS_BOUNDARY.length).toBeLessThan(400);
    expect(TRAVIS_BOUNDARY[0]).toEqual(TRAVIS_BOUNDARY.at(-1));
    const lats = TRAVIS_BOUNDARY.map(([, lat]) => lat);
    const lons = TRAVIS_BOUNDARY.map(([lon]) => lon);
    expect(Math.min(...lats)).toBeCloseTo(COUNTY.bounds.minLat, 3);
    expect(Math.max(...lats)).toBeCloseTo(COUNTY.bounds.maxLat, 3);
    expect(Math.min(...lons)).toBeCloseTo(COUNTY.bounds.minLon, 3);
    expect(Math.max(...lons)).toBeCloseTo(COUNTY.bounds.maxLon, 3);
  });

  it("accepts places in the county", () => {
    for (const [name, lat, lon] of [
      ["Downtown Austin", 30.2672, -97.7431],
      ["Pflugerville", 30.4394, -97.62],
      ["Lakeway", 30.3638, -97.9797],
      ["Manor", 30.3408, -97.5569],
      ["Del Valle", 30.188, -97.638],
      ["Jonestown", 30.4955, -97.9234],
    ] as const)
      expect(inCounty(lat, lon), name).toBe(true);
  });

  it("rejects neighbouring towns that the old bounding box let in", () => {
    for (const [name, lat, lon] of [
      ["Georgetown", 30.6327, -97.6779],
      ["Round Rock (downtown)", 30.5083, -97.6789],
      ["Kyle", 29.9891, -97.8772],
      ["Bastrop", 30.1105, -97.3153],
      ["Dripping Springs", 30.1902, -98.0867],
      ["Cedar Park", 30.5052, -97.8203],
      ["Miami", 25.76, -80.19],
    ] as const)
      expect(inCounty(lat, lon), name).toBe(false);
    expect(inCounty(Number.NaN, -97.7)).toBe(false);
  });

  it("allows points within a quarter mile of the line (TCAD geocodes, Round Rock and Buda slivers)", () => {
    // TCAD parcel centroids of the Round Rock and Buda parts of the county sit just outside the simplified line.
    expect(inRing(30.483264, -97.638886, TRAVIS_BOUNDARY)).toBe(false);
    expect(inCounty(30.483264, -97.638886)).toBe(true);
    expect(inCounty(30.121141, -97.846921)).toBe(true);
    expect(milesToRing(30.2672, -97.7431, TRAVIS_BOUNDARY)).toBeGreaterThan(5);
  });
});
