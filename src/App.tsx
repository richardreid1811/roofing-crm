import { useEffect, useState } from "react";
import { COUNTY } from "../shared/tools";
import DataInfo from "./components/DataInfo";
import PropertyDrawer from "./components/PropertyDrawer";
import { FUTURE_SECTIONS } from "./future";
import { useApp } from "./state";
import Agent from "./views/Agent";
import Finder from "./views/Finder";
import Future from "./views/Future";
import Leads from "./views/Leads";

// Hash routes: #/finder, #/leads, #/leads/<id>, #/agent, #/soon/<key>
function useRoute(): string[] {
  const parse = () => (window.location.hash.replace(/^#\/?/, "") || "finder").split("/");
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  const { snapshot, dbReady, loadSteps, loadError, leadsByProp, toasts } = useApp();
  const [showData, setShowData] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const view = route[0];

  useEffect(() => setNavOpen(false), [view]);

  const nav = (key: string, text: string, icon: string, badge?: number) => (
    <a href={`#/${key}`} className={`nav-item ${view === key ? "active" : ""}`}>
      <span className="nav-icon" aria-hidden>
        {icon}
      </span>
      {text}
      {badge !== undefined && <span className="badge">{badge}</span>}
    </a>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <button className="menu-btn" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}>
          ☰
        </button>
        <a href="#/finder" className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Travis Roofing CRM</span>
        </a>
        <span className="chip county">{COUNTY.name}</span>
        <button className="chip data" onClick={() => setShowData(true)} title="About this data">
          {loadError ? (
            <span className="err-dot">Data unavailable</span>
          ) : !snapshot ? (
            "Connecting…"
          ) : dbReady ? (
            <>Data: snapshot {snapshot.run_id.slice(0, 8)} · IPFS</>
          ) : (
            <>Loading data {loadSteps.length}/4…</>
          )}
        </button>
      </header>
      <nav className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="nav-group">
          {nav("finder", "Lead finder", "◎")}
          {nav("leads", "Leads", "☰", leadsByProp.size)}
          {nav("agent", "Assistant", "✦")}
        </div>
        <div className="nav-group">
          <div className="nav-heading">Coming soon</div>
          {FUTURE_SECTIONS.map((s) => (
            <a
              key={s.key}
              href={`#/soon/${s.key}`}
              className={`nav-item disabled ${view === "soon" && route[1] === s.key ? "active" : ""}`}
              aria-disabled="true"
              title={`${s.title}: not available yet`}
            >
              <span className="nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.title}
              <span className="soon">Soon</span>
            </a>
          ))}
        </div>
        <p className="nav-foot small muted">
          Data: Travis Central Appraisal District, City of Austin permits, NOAA. Read from IPFS in your browser.
        </p>
      </nav>
      <main className="main">
        {loadError && (
          <div className="banner error">
            Could not load the published data: {loadError}. Lead records still work; reload to retry.
          </div>
        )}
        {view === "leads" ? (
          <Leads leadId={route[1]} />
        ) : view === "agent" ? (
          <Agent />
        ) : view === "soon" ? (
          <Future sectionKey={route[1]} />
        ) : (
          <Finder />
        )}
      </main>
      <PropertyDrawer />
      {showData && <DataInfo onClose={() => setShowData(false)} />}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
