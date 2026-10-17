// Small SVG charts drawn with React. Colours come from the theme tokens, so light and dark both work.
import { fmtDate, qty } from "../lib/format.js";

const STROKE = { a: "stroke-series-a", b: "stroke-series-b", c: "stroke-series-c" };
const FILL = { a: "bg-series-a", b: "bg-series-b", c: "bg-series-c" };
const AREA = { a: "fill-series-a/10", b: "fill-series-b/10", c: "fill-series-c/10" };

/**
 * series = [{ label, points: [{x: 'YYYY-MM-DD', y}], color: 'a'|'b'|'c', dashed?, area?, band?: [{x, lo, hi}] }]
 * marker: an x value to draw a dashed "today" line at.
 */
export function LineChart({ series, height = 200, marker }) {
  const all = series.flatMap((s) => [...s.points, ...(s.band ?? []).map((b) => ({ x: b.x, y: b.hi }))]);
  if (!all.length) return <p className="text-muted">No data yet.</p>;
  const xs = [...new Set(all.map((p) => p.x))].sort();
  const maxY = Math.max(1, ...all.map((p) => p.y));
  const W = 680, H = height, padL = 40, padR = 12, padY = 22;
  const X = (x) => padL + (xs.indexOf(x) / Math.max(1, xs.length - 1)) * (W - padL - padR);
  const Y = (y) => H - padY - (y / maxY) * (H - padY * 2);
  const hasBand = series.some((s) => s.band?.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={series.map((s) => s.label).join(", ")}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={Y(maxY * f)} y2={Y(maxY * f)} className="stroke-line" strokeDasharray={f ? "2 4" : undefined} />
            <text x={padL - 6} y={Y(maxY * f) + 4} textAnchor="end" className="fill-muted text-[11px]">{qty(Math.round(maxY * f * 10) / 10)}</text>
          </g>
        ))}
        <text x={padL} y={H - 4} className="fill-muted text-[11px]">{fmtDate(xs[0])}</text>
        <text x={W - padR} y={H - 4} textAnchor="end" className="fill-muted text-[11px]">{fmtDate(xs[xs.length - 1])}</text>
        {marker && xs.includes(marker) && (
          <g>
            <line x1={X(marker)} x2={X(marker)} y1={padY} y2={H - padY} className="stroke-muted" strokeDasharray="3 3" />
            <text x={X(marker) + 4} y={padY + 10} className="fill-muted text-[11px]">today</text>
          </g>
        )}
        {series.map((s) => s.band?.length ? (
          <polygon key={s.label + "-band"} className="fill-band"
            points={[...s.band.map((p) => `${X(p.x)},${Y(p.hi)}`), ...s.band.slice().reverse().map((p) => `${X(p.x)},${Y(p.lo)}`)].join(" ")} />
        ) : null)}
        {series.map((s) => s.area && s.points.length > 1 ? (
          <polygon key={s.label + "-area"} className={AREA[s.color]}
            points={[`${X(s.points[0].x)},${Y(0)}`, ...s.points.map((p) => `${X(p.x)},${Y(p.y)}`), `${X(s.points[s.points.length - 1].x)},${Y(0)}`].join(" ")} />
        ) : null)}
        {series.map((s) => s.points.length ? (
          <polyline strokeLinejoin="round" strokeLinecap="round" key={s.label} fill="none" strokeWidth="2" className={STROKE[s.color]} strokeDasharray={s.dashed ? "6 4" : undefined}
            points={s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")} />
        ) : null)}
      </svg>
      <div className="flex flex-wrap gap-3.5 text-xs text-muted">
        {series.map((s) => <span key={s.label}><i className={`mr-1 inline-block size-2.5 rounded-sm align-[-1px] ${FILL[s.color]}`} />{s.label}</span>)}
        {hasBand && <span><i className="mr-1 inline-block size-2.5 rounded-sm border border-series-b bg-band align-[-1px]" />likely range (its upper bound sets safety stock)</span>}
      </div>
    </div>
  );
}

/** Two horizontal bars per row, e.g. model vs baseline error per tier. */
export function BarPairs({ rows, a, b, format = (v) => v }) {
  const max = Math.max(1e-9, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  const bar = (v, color, label) => (
    <div className="flex items-center gap-2 text-xs text-muted">
      <div className={`h-2.5 min-w-0.5 max-w-[70%] rounded-sm ${FILL[color]}`} style={{ width: `${((v ?? 0) / max) * 70}%` }} />
      <span>{label}: {format(v)}</span>
    </div>
  );
  return (
    <div className="my-2 grid gap-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid gap-1">
          <div className="text-xs font-semibold">{r.label}</div>
          {bar(r.a, "a", a)}
          {bar(r.b, "c", b)}
        </div>
      ))}
    </div>
  );
}
