import type { Row } from "../../shared/tools";

export const SIGNAL_COLORS = { permit: "#b42318", hail: "#6941c6", aged: "#c4610f" };

export const markerColor = (r: Row) =>
  r.signal_open_permit ? SIGNAL_COLORS.permit : r.signal_hail ? SIGNAL_COLORS.hail : SIGNAL_COLORS.aged;

export default function Signals({ row }: { row: Row }) {
  return (
    <div className="signals">
      {Boolean(row.signal_open_permit) && (
        <span className="tag permit" title="Open or never-finaled roofing permit">
          Open permit
        </span>
      )}
      {Boolean(row.signal_hail) && (
        <span className="tag hail" title="Severe hail reported within 1 mile since the roof year">
          Hail
        </span>
      )}
      {Boolean(row.signal_aged_roof) && (
        <span className="tag aged" title="Roof older than the threshold">
          Aged roof
        </span>
      )}
    </div>
  );
}
