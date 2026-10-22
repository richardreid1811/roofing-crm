// Which workspace this browser uses. No key means the public demo workspace (no login needed).
// A private workspace is a capability link, /#ws=<key>: the key lives in the URL fragment, which browsers
// never send to servers, and is kept in this browser's localStorage once the link is opened.
import { WORKSPACE_KEY_RE } from "../shared/workspaces";

export type SavedWorkspace = { key: string; name: string };
const LIST_KEY = "crm.workspaces";
const ACTIVE_KEY = "crm.workspace";

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(k: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked: the workspace still works for this tab */
  }
}

let active: string | null = (() => {
  const k = read<string | null>(ACTIVE_KEY, null);
  return k && WORKSPACE_KEY_RE.test(k) ? k : null;
})();
let saved: SavedWorkspace[] = read<SavedWorkspace[]>(LIST_KEY, []).filter((w) => WORKSPACE_KEY_RE.test(w?.key));

/** The key sent with every API request, or null for the demo workspace. */
export const activeKey = () => active;
export const savedWorkspaces = () => saved;

export function setActive(key: string | null) {
  active = key;
  write(ACTIVE_KEY, key);
}

export function remember(key: string, name: string) {
  saved = [{ key, name }, ...saved.filter((w) => w.key !== key)];
  write(LIST_KEY, saved);
}

export function forget(key: string) {
  saved = saved.filter((w) => w.key !== key);
  write(LIST_KEY, saved);
  if (active === key) setActive(null);
}

export const privateLink = (key: string) => `${window.location.origin}/#ws=${key}`;

/** If the URL is a private workspace link, store and activate its key and return it. */
export function adoptLink(): string | null {
  const m = window.location.hash.match(/^#ws=([^&]+)$/);
  if (!m || !WORKSPACE_KEY_RE.test(m[1])) return null;
  const key = m[1];
  if (!saved.some((w) => w.key === key)) remember(key, "Private workspace");
  setActive(key);
  // Drop the key from the address bar and history; the app routes continue from the leads list.
  window.history.replaceState(null, "", "#/leads");
  return key;
}
