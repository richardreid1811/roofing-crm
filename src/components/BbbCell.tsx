// BBB for a contractor: a rating from the data if present, else the latest rep-recorded rating, else
// "not in data". Always offers BBB's own search and a way to record what the rep finds there.
import { BBB_RATING_LABEL } from "../../shared/bbb";
import { bbbLookupUrl } from "../../shared/tools";
import { recordedRating } from "../bbb";
import { useApp } from "../state";

export default function BbbCell({
  rating,
  contractorKey,
  contractorName,
}: {
  rating: unknown;
  contractorKey: unknown;
  contractorName: unknown;
}) {
  const { openBbb, bbbVersion } = useApp();
  void bbbVersion; // re-render when a rating is recorded
  if (typeof rating === "string" && rating) return <span className="bbb">{rating}</span>;
  if (typeof contractorName !== "string" || !contractorName) return <span className="muted">—</span>;
  const key = typeof contractorKey === "string" && contractorKey.startsWith("contractor:") ? contractorKey : null;
  const rec = key ? recordedRating(key) : null;
  const lookup = bbbLookupUrl(contractorName);
  const record = key && (
    <button
      className="link small"
      onClick={(e) => {
        e.stopPropagation();
        openBbb({ key, name: contractorName });
      }}
    >
      {rec ? "update" : "record"}
    </button>
  );
  return (
    <span className="small bbb-cell" onClick={(e) => e.stopPropagation()}>
      {rec ? (
        <span
          className="bbb"
          title={`Recorded by ${rec.recorded_by ?? "a rep"} from bbb.org on ${new Date(rec.recorded_at).toLocaleDateString()}`}
        >
          {BBB_RATING_LABEL(rec.rating)}
          <span className="rep-tag">rep-entered</span>
        </span>
      ) : (
        <span className="muted" title="BBB offers no public API, so ratings are not in the data">
          Not in data
        </span>
      )}
      {lookup && (
        <>
          {" · "}
          <a href={lookup} target="_blank" rel="noreferrer" title="Opens BBB's own search in a new tab">
            Check BBB ↗
          </a>
        </>
      )}
      {record && <> · {record}</>}
    </span>
  );
}
