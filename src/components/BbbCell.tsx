// BBB score when the data has one; otherwise say so and offer a viewer-initiated lookup.
export default function BbbCell({
  rating,
  lookupUrl,
  hasContractor,
}: {
  rating: unknown;
  lookupUrl: unknown;
  hasContractor: boolean;
}) {
  if (typeof rating === "string" && rating) return <span className="bbb">{rating}</span>;
  if (!hasContractor) return <span className="muted">—</span>;
  return (
    <span className="small">
      <span className="muted" title="BBB offers no public API, so ratings are not in the data">
        Not in data
      </span>
      {typeof lookupUrl === "string" && (
        <>
          {" · "}
          <a href={lookupUrl} target="_blank" rel="noreferrer" title="Opens BBB's own search in a new tab">
            Check BBB ↗
          </a>
        </>
      )}
    </span>
  );
}
