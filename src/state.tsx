// App-wide state: the snapshot pointer, the in-browser database, the saved-lead index and toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_LEADS_PER_SAVE, type Lead, type LeadInput, type LeadRef } from "../shared/leads";
import { DEMO_WORKSPACE_NAME } from "../shared/workspaces";
import { api, ApiError, type Snapshot } from "./api";
import { initDb, type LoadStep } from "./db";
import { activeKey, adoptLink, forget, remember, setActive } from "./workspace";

type Toast = { id: number; text: string; kind: "ok" | "error" };
export type BbbTarget = { key: string; name: string };
/** The workspace in use: key null is the public demo workspace. */
export type ActiveWorkspace = { key: string | null; name: string };
type Ctx = {
  snapshot: Snapshot | null;
  dbReady: boolean;
  loadSteps: LoadStep[];
  loadError: string | null;
  /** Re-run the snapshot and data load after a failure or timeout. */
  retryLoad: () => void;
  /** Every saved property in the active workspace. */
  leadsByProp: Map<string, LeadRef>;
  refreshLeads: () => Promise<void>;
  saveLeads: (inputs: LeadInput[]) => Promise<{ created: Lead[]; existing: Lead[] } | null>;
  openProperty: (propId: string | null) => void;
  propertyId: string | null;
  toast: (text: string, kind?: Toast["kind"]) => void;
  toasts: Toast[];
  /** Contractor whose BBB rating dialog is open. */
  bbbTarget: BbbTarget | null;
  openBbb: (t: BbbTarget | null) => void;
  /** Bumped whenever a recorded rating changes, so cells re-read the cache. */
  bbbVersion: number;
  bbbChanged: () => void;
  workspace: ActiveWorkspace;
  /** Switch to a saved private workspace by key, or to the demo workspace with null. */
  switchWorkspace: (key: string | null) => void;
};
const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [loadSteps, setLoadSteps] = useState<LoadStep[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [leadsByProp, setLeadsByProp] = useState<Map<string, LeadRef>>(new Map());
  const leadsSeq = useRef(0);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bbbTarget, openBbb] = useState<BbbTarget | null>(null);
  const [bbbVersion, setBbbVersion] = useState(0);
  const bbbChanged = useCallback(() => setBbbVersion((v) => v + 1), []);
  const toastId = useRef(0);
  const [workspace, setWorkspace] = useState<ActiveWorkspace>(() => {
    const key = adoptLink() ?? activeKey();
    return { key, name: key ? "Private workspace" : DEMO_WORKSPACE_NAME };
  });
  const switchWorkspace = useCallback((key: string | null) => {
    setActive(key);
    setWorkspace({ key, name: key ? "Private workspace" : DEMO_WORKSPACE_NAME });
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  // A private workspace: confirm the key and learn its name; an invalid key falls back to the demo.
  useEffect(() => {
    const key = workspace.key;
    if (!key) return;
    let cancelled = false;
    api.workspace().then(
      ({ workspace: w }) => {
        if (cancelled) return;
        remember(key, w.name);
        setWorkspace((cur) => (cur.key === key ? { key, name: w.name } : cur));
      },
      (e: unknown) => {
        if (cancelled || !(e instanceof ApiError && e.status === 401)) return;
        forget(key);
        setWorkspace({ key: null, name: DEMO_WORKSPACE_NAME });
        toast("That private workspace link is not valid; showing the demo workspace.", "error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspace.key, toast]);

  // A workspace link pasted into an open tab only changes the hash.
  useEffect(() => {
    const on = () => {
      const key = adoptLink();
      if (!key) return;
      setWorkspace((cur) => (cur.key === key ? cur : { key, name: "Private workspace" }));
      window.dispatchEvent(new HashChangeEvent("hashchange")); // let the router see #/leads
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // Only the latest request for the workspace still in use may set the index: refreshes overlap (every
  // save ends with one) and a slower response can belong to a workspace the rep has since left.
  const refreshLeads = useCallback(async () => {
    const key = workspace.key;
    const seq = ++leadsSeq.current;
    const current = () => seq === leadsSeq.current && key === activeKey();
    try {
      const { leads } = await api.leadIndex(key);
      if (current()) setLeadsByProp(new Map(leads.map((l) => [l.prop_id, l])));
    } catch (e) {
      if (current()) toast(`Could not load leads: ${(e as Error).message}`, "error");
    }
  }, [toast, workspace.key]);

  const saveLeads = useCallback(
    async (inputs: LeadInput[]) => {
      if (!inputs.length) return null;
      // Every chunk goes to the workspace in use when the save started, even if the rep switches meanwhile.
      const key = activeKey();
      try {
        // Larger selections go in requests of MAX_LEADS_PER_SAVE; a failure keeps what earlier chunks saved.
        const res: { created: Lead[]; existing: Lead[] } = { created: [], existing: [] };
        try {
          for (let i = 0; i < inputs.length; i += MAX_LEADS_PER_SAVE) {
            const part = await api.createLeads(inputs.slice(i, i + MAX_LEADS_PER_SAVE), key);
            res.created.push(...part.created);
            res.existing.push(...part.existing);
          }
        } finally {
          await refreshLeads();
        }
        const parts = [];
        if (res.created.length) parts.push(`${res.created.length} lead${res.created.length > 1 ? "s" : ""} created`);
        if (res.existing.length) parts.push(`${res.existing.length} already in the CRM`);
        toast(parts.join(", "));
        return res;
      } catch (e) {
        toast(`Could not save: ${(e as Error).message}`, "error");
        return null;
      }
    },
    [refreshLeads, toast],
  );

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoadSteps([]);
    setDbReady(false);
    setLoadAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.snapshot();
        if (cancelled) return;
        setSnapshot(snap);
        await initDb(snap, (s) => !cancelled && setLoadSteps((x) => [...x, s]));
        if (!cancelled) setDbReady(true);
      } catch (e) {
        if (!cancelled) setLoadError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    setLeadsByProp(new Map()); // a new workspace: no markers from the previous one while it loads
    void refreshLeads();
  }, [refreshLeads]);

  const value = useMemo<Ctx>(
    () => ({
      snapshot,
      dbReady,
      loadSteps,
      loadError,
      retryLoad,
      leadsByProp,
      refreshLeads,
      saveLeads,
      openProperty: setPropertyId,
      propertyId,
      toast,
      toasts,
      bbbTarget,
      openBbb,
      bbbVersion,
      bbbChanged,
      workspace,
      switchWorkspace,
    }),
    [
      snapshot,
      dbReady,
      loadSteps,
      loadError,
      retryLoad,
      leadsByProp,
      refreshLeads,
      saveLeads,
      propertyId,
      toast,
      toasts,
      bbbTarget,
      bbbVersion,
      bbbChanged,
      workspace,
      switchWorkspace,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
