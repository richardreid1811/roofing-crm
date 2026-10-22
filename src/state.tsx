// App-wide state: the snapshot pointer, the in-browser database, the saved-lead index and toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_LEADS_PER_SAVE, type Lead, type LeadInput } from "../shared/leads";
import { api, type Snapshot } from "./api";
import { initDb, type LoadStep } from "./db";

type Toast = { id: number; text: string; kind: "ok" | "error" };
export type BbbTarget = { key: string; name: string };
type Ctx = {
  snapshot: Snapshot | null;
  dbReady: boolean;
  loadSteps: LoadStep[];
  loadError: string | null;
  /** Re-run the snapshot and data load after a failure or timeout. */
  retryLoad: () => void;
  leadsByProp: Map<string, Lead>;
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
  const [leadsByProp, setLeadsByProp] = useState<Map<string, Lead>>(new Map());
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bbbTarget, openBbb] = useState<BbbTarget | null>(null);
  const [bbbVersion, setBbbVersion] = useState(0);
  const bbbChanged = useCallback(() => setBbbVersion((v) => v + 1), []);
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const refreshLeads = useCallback(async () => {
    try {
      const { leads } = await api.listLeads();
      setLeadsByProp(new Map(leads.map((l) => [l.prop_id, l])));
    } catch (e) {
      toast(`Could not load leads: ${(e as Error).message}`, "error");
    }
  }, [toast]);

  const saveLeads = useCallback(
    async (inputs: LeadInput[]) => {
      if (!inputs.length) return null;
      try {
        // Larger selections go in requests of MAX_LEADS_PER_SAVE; a failure keeps what earlier chunks saved.
        const res: { created: Lead[]; existing: Lead[] } = { created: [], existing: [] };
        try {
          for (let i = 0; i < inputs.length; i += MAX_LEADS_PER_SAVE) {
            const part = await api.createLeads(inputs.slice(i, i + MAX_LEADS_PER_SAVE));
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
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
