// Workspace badge and switcher in the top bar. The demo workspace is public and needs no login; a private
// workspace is reached through its private link (the key is in the #ws= fragment, never sent to servers).
import { useEffect, useRef, useState } from "react";
import { DEMO_WORKSPACE_NAME } from "../../shared/workspaces";
import { api } from "../api";
import { useApp } from "../state";
import { forget, privateLink, remember, savedWorkspaces } from "../workspace";

export default function WorkspaceSwitcher() {
  const { workspace, switchWorkspace, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (key: string | null) => {
    setOpen(false);
    if (key === workspace.key) return;
    switchWorkspace(key);
    if (window.location.hash.startsWith("#/leads/")) window.location.hash = "#/leads";
  };

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Private link copied");
    } catch {
      toast("Could not copy; select the link and copy it", "error");
    }
  }

  async function remove() {
    if (!workspace.key) return;
    setOpen(false);
    if (!window.confirm(`Delete "${workspace.name}" and all its leads for everyone who has the link?`)) return;
    try {
      await api.deleteWorkspace();
      forget(workspace.key);
      pick(null);
      toast("Private workspace deleted");
    } catch (e) {
      toast(`Could not delete: ${(e as Error).message}`, "error");
    }
  }

  const priv = workspace.key !== null;
  return (
    <div className="ws" ref={ref}>
      <button
        className={`chip ws-badge ${priv ? "private" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={priv ? "Private workspace: only people with its link can see it" : "Anyone can see and edit this demo"}
      >
        {priv ? `Private · ${workspace.name}` : DEMO_WORKSPACE_NAME} ▾
      </button>
      {open && (
        <div className="ws-menu card" role="menu">
          <div className="ws-heading">Workspace</div>
          <button role="menuitemradio" aria-checked={!priv} onClick={() => pick(null)}>
            {!priv ? "✓ " : ""}
            {DEMO_WORKSPACE_NAME}
          </button>
          {savedWorkspaces().map((w) => (
            <button key={w.key} role="menuitemradio" aria-checked={workspace.key === w.key} onClick={() => pick(w.key)}>
              {workspace.key === w.key ? "✓ " : ""}Private · {w.name}
            </button>
          ))}
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            Create private workspace…
          </button>
          {priv && (
            <>
              <button role="menuitem" onClick={() => copy(privateLink(workspace.key!))}>
                Copy private link
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  forget(workspace.key!);
                  pick(null);
                }}
              >
                Forget on this device
              </button>
              <button role="menuitem" className="danger-text" onClick={remove}>
                Delete workspace…
              </button>
            </>
          )}
        </div>
      )}
      {creating && <CreateWorkspace onClose={() => setCreating(false)} onCopy={copy} />}
    </div>
  );
}

function CreateWorkspace({ onClose, onCopy }: { onClose: () => void; onCopy: (t: string) => void }) {
  const { switchWorkspace } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const { workspace, key } = await api.createWorkspace(name.trim());
      remember(key, workspace.name);
      switchWorkspace(key);
      setLink(privateLink(key));
      window.location.hash = "#/leads";
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={link ? undefined : onClose}>
      <div
        className="modal card narrow"
        role="dialog"
        aria-label="Create private workspace"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between">
          <h2>{link ? "Private workspace created" : "Create private workspace"}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {!link ? (
          <>
            <p className="small">
              A private workspace has its own leads, hidden from the public demo. There are no accounts: anyone with its
              private link can open and edit it. BBB ratings stay shared, since they are public facts.
            </p>
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && create()}
                placeholder="e.g. Acme Roofing"
                maxLength={60}
                autoFocus
              />
            </label>
            {err && <div className="error small">{err}</div>}
            <div className="row gap">
              <button className="primary" disabled={!name.trim() || busy} onClick={create}>
                {busy ? "Creating…" : "Create"}
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="banner warn small">
              Keep this link now. It is the only way back into this workspace: the key is shown once, the server keeps
              only a hash of it, and it cannot be recovered. Anyone with the link can see and edit these leads.
            </div>
            <label className="field">
              <span>Private link</span>
              <input readOnly value={link} onFocus={(e) => e.target.select()} className="mono" />
            </label>
            <div className="row gap">
              <button className="primary" onClick={() => onCopy(link)}>
                Copy link
              </button>
              <button onClick={onClose}>Done</button>
            </div>
            <p className="muted small">This browser remembers the workspace; switch back to the demo from the badge.</p>
          </>
        )}
      </div>
    </div>
  );
}
