// Disabled placeholder for a planned CRM section.
import { FUTURE_SECTIONS } from "../future";

export default function Future({ sectionKey }: { sectionKey?: string }) {
  const s = FUTURE_SECTIONS.find((x) => x.key === sectionKey) ?? FUTURE_SECTIONS[0];
  return (
    <section className="card future" aria-disabled="true">
      <div className="row gap">
        <span className="future-icon" aria-hidden>
          {s.icon}
        </span>
        <div>
          <h1>
            {s.title} <span className="soon">Coming soon</span>
          </h1>
          <p className="muted">{s.summary}</p>
        </div>
      </div>
      <div className="future-preview">
        <div className="row gap wrap">
          <button className="primary" disabled>
            New {s.title.toLowerCase().replace(/s$/, "")}
          </button>
          <input disabled placeholder="Search" />
          <select disabled>
            <option>All</option>
          </select>
        </div>
        <ul>
          {s.features.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <p className="small muted">
        Not part of the lead-identification release. Requires: {s.needs} Saved leads will carry over when this section
        ships.
      </p>
    </section>
  );
}
