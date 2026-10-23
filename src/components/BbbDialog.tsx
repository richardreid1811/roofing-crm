// Record a contractor's BBB rating as read by a rep on bbb.org. The app links to BBB's own search but
// never fetches BBB; the rating, accreditation and profile link are whatever the rep enters.
import { useEffect, useRef, useState } from "react";
import { BBB_RATING_LABEL, BBB_RATINGS, type BbbRating, type BbbRatingValue } from "../../shared/bbb";
import { bbbLookupUrl } from "../../shared/tools";
import { api } from "../api";
import { setRecorded } from "../bbb";
import { useApp } from "../state";

const NAME_KEY = "crm.recorded_by";
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export default function BbbDialog() {
  const { bbbTarget, openBbb, bbbChanged, toast } = useApp();
  const [history, setHistory] = useState<BbbRating[]>([]);
  const [rating, setRating] = useState<BbbRatingValue | "">("");
  const [accredited, setAccredited] = useState<"" | "yes" | "no">("");
  const [profileUrl, setProfileUrl] = useState("");
  const [recordedBy, setRecordedBy] = useState(savedName);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The dialog stays mounted between contractors: start each one empty and drop a response that
  // arrives after the dialog moved on, so "remove" only ever acts on this contractor's entries.
  const target = useRef<string | null>(null);
  useEffect(() => {
    target.current = bbbTarget?.key ?? null;
    setHistory([]);
    if (!bbbTarget) return;
    setRating("");
    setAccredited("");
    setProfileUrl("");
    setNote("");
    setErr(null);
    let cancelled = false;
    api.bbbHistory(bbbTarget.key).then(
      (r) => !cancelled && setHistory(r.history),
      () => !cancelled && setHistory([]),
    );
    return () => {
      cancelled = true;
    };
  }, [bbbTarget]);

  if (!bbbTarget) return null;
  const close = () => openBbb(null);
  const lookup = bbbLookupUrl(bbbTarget.name);

  async function save() {
    if (!bbbTarget || !rating) return;
    setBusy(true);
    setErr(null);
    try {
      const { rating: saved } = await api.recordBbb({
        contractor_key: bbbTarget.key,
        contractor_name: bbbTarget.name,
        rating,
        accredited: accredited === "" ? null : accredited === "yes",
        profile_url: profileUrl.trim() || null,
        recorded_by: recordedBy.trim() || null,
        note: note.trim() || null,
      });
      try {
        localStorage.setItem(NAME_KEY, recordedBy.trim());
      } catch {
        /* name memory is a convenience only */
      }
      setRecorded(bbbTarget.key, saved);
      bbbChanged();
      toast(`BBB rating recorded for ${bbbTarget.name}`);
      close();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: BbbRating) {
    const key = entry.contractor_key;
    try {
      await api.deleteBbbEntry(entry.id);
      // `history` is this entry's contractor's list (it is reset per contractor); the cache update goes to
      // that contractor, and the list only changes if the dialog is still showing it.
      const rest = history.filter((h) => h.id !== entry.id);
      setRecorded(key, rest[0] ?? null);
      if (target.current === key) setHistory(rest);
      bbbChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal card narrow"
        role="dialog"
        aria-label="Record BBB rating"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between">
          <h2>BBB rating</h2>
          <button className="ghost" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="addr">{bbbTarget.name}</p>
        <ol className="steps small">
          <li>
            Look the contractor up on BBB:{" "}
            {lookup && (
              <a className="button small" href={lookup} target="_blank" rel="noreferrer">
                Open BBB search ↗
              </a>
            )}
          </li>
          <li>Record what BBB shows. It is saved for this contractor and shown wherever it appears.</li>
        </ol>
        <div className="grid2">
          <label className="field">
            <span>Rating</span>
            <select value={rating} onChange={(e) => setRating(e.target.value as BbbRatingValue)}>
              <option value="">Choose…</option>
              {BBB_RATINGS.map((r) => (
                <option key={r} value={r}>
                  {BBB_RATING_LABEL(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>BBB accredited</span>
            <select value={accredited} onChange={(e) => setAccredited(e.target.value as "" | "yes" | "no")}>
              <option value="">Not recorded</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>BBB profile link (optional)</span>
          <input
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="https://www.bbb.org/us/tx/austin/profile/…"
          />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Your name</span>
            <input
              value={recordedBy}
              onChange={(e) => setRecordedBy(e.target.value)}
              placeholder="Sales rep"
              maxLength={80}
            />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. 3 complaints in 3 years"
              maxLength={500}
            />
          </label>
        </div>
        {err && <div className="error small">{err}</div>}
        <div className="row gap">
          <button className="primary" disabled={!rating || busy} onClick={save}>
            {busy ? "Saving…" : "Save rating"}
          </button>
          <button onClick={close}>Cancel</button>
        </div>
        {history.length > 0 && (
          <>
            <h3>Recorded so far</h3>
            <ul className="history small">
              {history.map((h, i) => (
                <li key={h.id}>
                  <strong>{BBB_RATING_LABEL(h.rating)}</strong>
                  {h.accredited !== null ? ` · ${h.accredited ? "accredited" : "not accredited"}` : ""} ·{" "}
                  {new Date(h.recorded_at).toLocaleDateString()}
                  {h.recorded_by ? ` · ${h.recorded_by}` : ""}
                  {i === 0 ? " · current" : ""}
                  {h.profile_url && (
                    <>
                      {" · "}
                      <a href={h.profile_url} target="_blank" rel="noreferrer">
                        profile ↗
                      </a>
                    </>
                  )}
                  {h.note ? <div className="muted">{h.note}</div> : null}
                  <button className="ghost small danger-text" onClick={() => remove(h)} title="Remove this entry">
                    remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">
          BBB has no public API and blocks automated access, so this app never contacts BBB. Ratings here are entered by
          reps and labelled that way. Ratings are shared by every workspace, including private ones: a rating is a
          public fact about the contractor.
        </p>
      </div>
    </div>
  );
}
