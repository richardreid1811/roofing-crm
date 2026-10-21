import { fmt } from "../format";
import { useApp } from "../state";

const PIPELINE = "https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx";

export default function DataInfo({ onClose }: { onClose: () => void }) {
  const { snapshot, loadSteps, dbReady } = useApp();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-label="About this data" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>About this data</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p>
          The CRM reads a published, content-addressed snapshot of Travis County property and permit data. Tables are
          fetched from public IPFS gateways by CID and queried in your browser with DuckDB. Data gathering and ingestion
          happen in the separate{" "}
          <a href={PIPELINE} target="_blank" rel="noreferrer">
            Oracle pipeline
          </a>
          ; this app only consumes its output.
        </p>
        {snapshot && (
          <dl className="facts">
            <dt>Snapshot</dt>
            <dd>{snapshot.run_id}</dd>
            <dt>Published</dt>
            <dd>{new Date(snapshot.published_at).toLocaleString()}</dd>
            <dt>Manifest CID</dt>
            <dd className="mono">{snapshot.manifest_cid}</dd>
            <dt>Root CID</dt>
            <dd className="mono">{snapshot.root_cid}</dd>
            {snapshot.stale && (
              <>
                <dt>Status</dt>
                <dd>Showing the last known snapshot (history temporarily unreachable)</dd>
              </>
            )}
          </dl>
        )}
        <h3>Tables loaded {dbReady ? "" : "(loading…)"}</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Table</th>
              <th>Rows</th>
              <th>Gateway</th>
              <th>Time</th>
              <th>CID</th>
            </tr>
          </thead>
          <tbody>
            {loadSteps.map((s) => (
              <tr key={s.table}>
                <td>{s.table}</td>
                <td>{fmt(s.rows)}</td>
                <td>{new URL(s.gateway).host}</td>
                <td>{(s.ms / 1000).toFixed(1)} s</td>
                <td className="mono small">
                  <a href={`${s.gateway}/ipfs/${s.cid}`} target="_blank" rel="noreferrer">
                    {s.cid.slice(0, 14)}…
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Coverage and limits</h3>
        <ul className="small">
          <li>
            Roof age comes from finaled or issued re-roof permits where they exist, otherwise from TCAD year built (an
            estimate, marked low confidence).
          </li>
          <li>
            Permit history covers the City of Austin. Unincorporated Travis County issues no building permits; other
            cities are not ingested yet.
          </li>
          <li>
            BBB ratings are not in the data: BBB blocks automated access and offers no public API. Each contractor has a
            “Check BBB” link instead.
          </li>
          <li>Hail is NOAA Storm Events point reports, a lead signal rather than proof of damage.</li>
        </ul>
      </div>
    </div>
  );
}
