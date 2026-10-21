import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { useEffect, useMemo, useRef, useState } from "react";
import { COUNTY, inCounty, LEAD_SCORE_EXPLAINED, type Row } from "../../shared/tools";
import { runTool } from "../db";
import { fmt, label, toLeadInput } from "../format";
import { useApp } from "../state";
import Signals, { markerColor } from "../components/Signals";
import BbbCell from "../components/BbbCell";

// Bundlers break Leaflet's CSS-relative default icon paths; point them at the bundled images.
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

type Center = { lat: number; lon: number; label: string };
type SortKey = "lead_score" | "roof_age_years" | "oldest_open_years" | "distance_miles";
type Filters = {
  radius: number;
  ageOn: boolean;
  age: number;
  permitOn: boolean;
  permitYears: number;
  statusOpen: boolean;
  statusExpired: boolean;
  hailOn: boolean;
  match: "any" | "all";
  residential: boolean;
};
const DEFAULT_FILTERS: Filters = {
  radius: 1.5,
  ageOn: true,
  age: 15,
  permitOn: true,
  permitYears: 0,
  statusOpen: true,
  statusExpired: true,
  hailOn: false,
  match: "any",
  residential: false,
};
const ROW_LIMIT = 200;

export default function Finder() {
  const { dbReady, snapshot, saveLeads, leadsByProp, openProperty, toast } = useApp();
  const [center, setCenter] = useState<Center>({ ...COUNTY.defaultPin });
  const [place, setPlace] = useState("");
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState<Row | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("lead_score");
  const [locating, setLocating] = useState(false);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));

  // ---- map
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const areaLayer = useRef<L.LayerGroup | null>(null);
  const rowLayer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([COUNTY.defaultPin.lat, COUNTY.defaultPin.lon], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    // County extent so the default view reads as "Travis County".
    const b = COUNTY.bounds;
    L.rectangle(
      [
        [b.minLat, b.minLon],
        [b.maxLat, b.maxLon],
      ],
      { color: "#7a5c4f", weight: 1, dashArray: "4 4", fill: false, interactive: false },
    ).addTo(m);
    areaLayer.current = L.layerGroup().addTo(m);
    rowLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => {
      if (!inCounty(e.latlng.lat, e.latlng.lng)) return toast("That point is outside Travis County.", "error");
      setCenter({ lat: e.latlng.lat, lon: e.latlng.lng, label: "Dropped pin" });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [toast]);

  useEffect(() => {
    const layer = areaLayer.current;
    if (!layer) return;
    layer.clearLayers();
    const circle = L.circle([center.lat, center.lon], {
      radius: f.radius * 1609.34,
      color: "#b4441c",
      weight: 1.5,
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(layer);
    map.current?.fitBounds(circle.getBounds(), { padding: [12, 12] });
    const pin = L.marker([center.lat, center.lon], { draggable: true, title: "Search center (drag to move)" })
      .bindTooltip(center.label)
      .addTo(layer);
    pin.on("dragend", () => {
      const p = pin.getLatLng();
      if (inCounty(p.lat, p.lng)) setCenter({ lat: p.lat, lon: p.lng, label: "Dropped pin" });
      else {
        toast("That point is outside Travis County.", "error");
        pin.setLatLng([center.lat, center.lon]);
      }
    });
  }, [center, f.radius, toast]);

  useEffect(() => {
    const layer = rowLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const r of rows) {
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const saved = leadsByProp.has(String(r.prop_id));
      L.circleMarker([lat, lon], {
        radius: 4 + Math.min(Number(r.lead_score ?? 0), 90) / 15,
        color: saved ? "#111" : "#fff",
        weight: saved ? 2 : 1,
        fillColor: markerColor(r),
        fillOpacity: 0.85,
      })
        .bindTooltip(`${String(r.situs_address ?? "")} · score ${fmt(r.lead_score)}`)
        .on("click", () => openProperty(String(r.prop_id)))
        .addTo(layer);
    }
  }, [rows, leadsByProp, openProperty]);

  // ---- search (debounced; reruns whenever the location or filters change)
  const args = useMemo(
    () => ({
      latitude: center.lat,
      longitude: center.lon,
      radius_miles: f.radius,
      roof_older_than_years: f.ageOn ? f.age : undefined,
      open_permit_min_years: f.permitOn ? f.permitYears : undefined,
      permit_statuses: [...(f.statusOpen ? ["open"] : []), ...(f.statusExpired ? ["expired_unfinaled"] : [])],
      hail_since_roof: f.hailOn,
      match: f.match,
      residential_only: f.residential,
      limit: ROW_LIMIT,
    }),
    [center, f],
  );
  const noCriteria = !f.ageOn && !f.permitOn && !f.hailOn;
  const noStatus = f.permitOn && !f.statusOpen && !f.statusExpired;
  useEffect(() => {
    if (!dbReady || noCriteria || noStatus) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      setErr(null);
      try {
        const res = await runTool("find_leads", args);
        if (cancelled) return;
        setRows(res.rows);
        setCount(res.count);
        setSelected(new Set());
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message ?? e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [args, dbReady, noCriteria, noStatus]);

  async function goToPlace() {
    if (!place.trim()) return;
    try {
      const { rows: hits } = await runTool("resolve_place", { name: place });
      if (!hits.length) return setErr(`No Travis County place matches "${place}".`);
      const h = hits[0];
      setCenter({ lat: Number(h.latitude), lon: Number(h.longitude), label: String(h.name) });
      map.current?.setView([Number(h.latitude), Number(h.longitude)], 14);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  function useGps() {
    if (!navigator.geolocation) return toast("This browser has no location access.", "error");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude } = pos.coords;
        if (!inCounty(latitude, longitude))
          return toast("You are outside Travis County; drop a pin on the map instead.", "error");
        setCenter({ lat: latitude, lon: longitude, label: "My location" });
        map.current?.setView([latitude, longitude], 15);
      },
      (e) => {
        setLocating(false);
        toast(`Location unavailable: ${e.message}`, "error");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const sorted = useMemo(() => {
    const dir = sort === "distance_miles" ? 1 : -1;
    return [...rows].sort((a, b) => dir * ((Number(a[sort] ?? -1) || 0) - (Number(b[sort] ?? -1) || 0)));
  }, [rows, sort]);
  const savable = sorted.filter((r) => !leadsByProp.has(String(r.prop_id)));
  const allSelected = savable.length > 0 && savable.every((r) => selected.has(String(r.prop_id)));

  async function saveSelected() {
    if (!snapshot) return;
    const inputs = sorted
      .filter((r) => selected.has(String(r.prop_id)))
      .map((r) => toLeadInput(r, snapshot, "finder"))
      .filter((x) => x !== null);
    const res = await saveLeads(inputs);
    if (res) setSelected(new Set());
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const th = (key: SortKey, text: string) => (
    <th>
      <button className={`sort ${sort === key ? "on" : ""}`} onClick={() => setSort(key)}>
        {text}
        {sort === key ? (key === "distance_miles" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div className="finder">
      <aside className="card filters">
        <h2>Find leads</h2>
        <label className="field">
          <span>Location</span>
          <div className="inline">
            <input
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goToPlace()}
              placeholder="City, ZIP or neighborhood"
              disabled={!dbReady}
            />
            <button onClick={goToPlace} disabled={!dbReady || !place.trim()}>
              Go
            </button>
          </div>
        </label>
        <button className="wide" onClick={useGps} disabled={locating}>
          {locating ? "Locating…" : "⌖ Use my location"}
        </button>
        <p className="muted small">
          Or click the map (or drag the pin) to set the center. Now: <strong>{center.label}</strong> (
          {center.lat.toFixed(4)}, {center.lon.toFixed(4)})
        </p>
        <label className="field">
          <span>
            Radius: <strong>{f.radius} mi</strong>
          </span>
          <input
            type="range"
            min={0.25}
            max={10}
            step={0.25}
            value={f.radius}
            onChange={(e) => set("radius", Number(e.target.value))}
          />
        </label>

        <fieldset>
          <legend>Lead criteria</legend>
          <label className="check">
            <input type="checkbox" checked={f.ageOn} onChange={(e) => set("ageOn", e.target.checked)} />
            Roof older than
            <input
              className="num"
              type="number"
              min={0}
              max={100}
              value={f.age}
              disabled={!f.ageOn}
              onChange={(e) => set("age", Number(e.target.value))}
            />
            years
          </label>
          <label className="check">
            <input type="checkbox" checked={f.permitOn} onChange={(e) => set("permitOn", e.target.checked)} />
            Open roofing permit, open at least
            <input
              className="num"
              type="number"
              min={0}
              max={40}
              step={0.5}
              value={f.permitYears}
              disabled={!f.permitOn}
              onChange={(e) => set("permitYears", Number(e.target.value))}
            />
            years
          </label>
          <div className={`sub ${f.permitOn ? "" : "dim"}`}>
            <label className="check small">
              <input
                type="checkbox"
                checked={f.statusOpen}
                disabled={!f.permitOn}
                onChange={(e) => set("statusOpen", e.target.checked)}
              />
              Open (active)
            </label>
            <label className="check small">
              <input
                type="checkbox"
                checked={f.statusExpired}
                disabled={!f.permitOn}
                onChange={(e) => set("statusExpired", e.target.checked)}
              />
              Expired, never finaled
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.hailOn} onChange={(e) => set("hailOn", e.target.checked)} />
            Severe hail since roof (NOAA, ≥ 1.75 in within 1 mi)
          </label>
          <div className="segmented" role="group" aria-label="Match">
            <button className={f.match === "any" ? "on" : ""} onClick={() => set("match", "any")}>
              Match any
            </button>
            <button className={f.match === "all" ? "on" : ""} onClick={() => set("match", "all")}>
              Match all
            </button>
          </div>
          <label className="check small">
            <input type="checkbox" checked={f.residential} onChange={(e) => set("residential", e.target.checked)} />
            Residential only
          </label>
        </fieldset>
        <div className="row gap">
          <button className="ghost small" onClick={() => setF(DEFAULT_FILTERS)}>
            Reset filters
          </button>
          <button
            className="ghost small"
            onClick={() => setF((x) => ({ ...x, ageOn: false, permitOn: true, permitYears: 5, hailOn: false }))}
          >
            Long-open permits only
          </button>
        </div>
        {noCriteria && <div className="error small">Turn on at least one lead criterion.</div>}
        {noStatus && <div className="error small">Pick at least one permit status.</div>}
        {err && <div className="error small">{err}</div>}
        <div className="legend small">
          <span>
            <i style={{ background: "#b42318" }} /> Open permit
          </span>
          <span>
            <i style={{ background: "#6941c6" }} /> Hail since roof
          </span>
          <span>
            <i style={{ background: "#c4610f" }} /> Aged roof
          </span>
          <span>
            <i className="ring" /> Saved lead
          </span>
        </div>
      </aside>

      <section className="map-wrap card">
        <div ref={mapEl} className="map" />
      </section>

      <section className="card results">
        <div className="row between wrap">
          <div>
            <h2 className="inline-h">Lead candidates</h2>{" "}
            {busy ? (
              <span className="muted">Searching…</span>
            ) : !dbReady ? (
              <span className="muted">Loading Travis County data from IPFS…</span>
            ) : count ? (
              <span className="muted">
                <strong>{fmt(count.matches)}</strong> properties in {f.radius} mi
                {f.ageOn ? ` · ${fmt(count.aged_roof)} aged roofs` : ""}
                {f.permitOn ? ` · ${fmt(count.open_permit)} with open permits` : ""}
                {f.hailOn ? ` · ${fmt(count.hail)} with hail` : ""}
                {Number(count.matches) > rows.length ? ` · top ${rows.length} by score` : ""}
              </span>
            ) : null}
          </div>
          <button className="primary" disabled={!selected.size} onClick={saveSelected}>
            Save {selected.size || ""} as lead{selected.size === 1 ? "" : "s"}
          </button>
        </div>
        <div className="scroll">
          <table className="tbl leads-tbl">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(savable.map((r) => String(r.prop_id))))
                    }
                  />
                </th>
                {th("lead_score", "Score")}
                <th>Property</th>
                <th>Signals</th>
                {th("roof_age_years", "Roof age")}
                {th("oldest_open_years", "Open permit")}
                <th>Contractor</th>
                <th>BBB</th>
                {th("distance_miles", "Dist.")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const id = String(r.prop_id);
                const lead = leadsByProp.get(id);
                return (
                  <tr key={id} className="clickable" onClick={() => openProperty(id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {lead ? (
                        <a href={`#/leads/${lead.id}`} className="saved" title="Already a lead">
                          ✓
                        </a>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`Select ${String(r.situs_address)}`}
                          checked={selected.has(id)}
                          onChange={() => toggle(id)}
                        />
                      )}
                    </td>
                    <td>
                      <span className="score" title={LEAD_SCORE_EXPLAINED}>
                        {fmt(r.lead_score)}
                      </span>
                    </td>
                    <td>
                      <div className="addr">{fmt(r.situs_address)}</div>
                      <div className="muted small">{label(r.jurisdiction)}</div>
                    </td>
                    <td>
                      <Signals row={r} />
                    </td>
                    <td>
                      <div>{r.roof_age_years != null ? `${fmt(r.roof_age_years)} yrs` : "—"}</div>
                      <div className="muted small">{label(r.roof_age_confidence)} confidence</div>
                    </td>
                    <td>
                      {r.oldest_open_permit ? (
                        <>
                          <div>{fmt(r.oldest_open_years)} yrs open</div>
                          <div className="muted small">{fmt(r.oldest_open_status)}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">{fmt(r.oldest_open_contractor)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <BbbCell
                        rating={r.bbb_rating}
                        lookupUrl={r.bbb_lookup_url}
                        hasContractor={!!r.oldest_open_contractor}
                      />
                    </td>
                    <td>{fmt(r.distance_miles)}</td>
                  </tr>
                );
              })}
              {!sorted.length && !busy && dbReady && (
                <tr>
                  <td colSpan={9} className="muted center">
                    No properties match. Widen the radius or relax the criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small">{LEAD_SCORE_EXPLAINED}</p>
      </section>
    </div>
  );
}
