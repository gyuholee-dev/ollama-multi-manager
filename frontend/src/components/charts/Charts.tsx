import type { ReactNode } from 'react';

const W = 300;
const H = 64;

/** A round upper limit at or above `v` (1, 1.5, 2, 3, 5 or 10 times a power of ten), for graphs that have no hardware limit. */
export function niceMax(v: number, floor = 1): number {
  const x = Math.max(v, floor);
  const mag = 10 ** Math.floor(Math.log10(x));
  const step = [1, 1.5, 2, 3, 5, 10].find((m) => m * mag >= x - 1e-9) ?? 10;
  return step * mag;
}

interface FrameProps {
  title: string;
  value?: ReactNode;
  left: string;
  right: string;
  avg?: { text: string; y: number }; // the average of what is shown: its label (top left) and the height of its line
  children: ReactNode;
}

function Frame({ title, value, left, right, avg, children }: FrameProps) {
  return (
    <div className="chart">
      <div className="chh"><span className="sub">{title}</span>{value != null && <span className="val">{value}</span>}</div>
      <div className="plot">{avg && <span className="ymax" style={{ top: avg.y + 5 }}>{avg.text}</span>}
      <svg className="rqc" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="gl" vectorEffect="non-scaling-stroke" />)}
        {children}
        {avg && <line x1="0" x2={W} y1={avg.y.toFixed(1)} y2={avg.y.toFixed(1)} className="av" vectorEffect="non-scaling-stroke" />}
      </svg></div>
      <div className="chf sub"><span>{left}</span><span>{right}</span></div>
    </div>
  );
}

interface LineProps {
  title: string;
  value?: ReactNode;
  points: (number | null)[];
  left: string;
  right: string;
  /** Top of the scale; defaults to the largest value (at least `floor`). */
  max?: number;
  floor?: number;
  format: (v: number) => string;
}

/** A line over time. Gaps (null) break the line. */
export function LineChart({ title, value, points, left, right, max, floor = 1, format }: LineProps) {
  const shown = points.filter((p): p is number => p != null);
  const top = Math.max(max ?? 0, ...shown, floor); // the scale never clips a reading
  const mean = shown.length ? shown.reduce((a, b) => a + b, 0) / shown.length : null;
  const yOf = (v: number) => H - 3 - (Math.min(v, top) / top) * (H - 6);
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const runs: string[][] = [[]];
  points.forEach((p, k) => {
    if (p == null) { if (runs.at(-1)?.length) runs.push([]); return; }
    runs.at(-1)?.push(`${(k * step).toFixed(1)},${yOf(p).toFixed(1)}`);
  });
  return (
    <Frame title={title} value={value} left={left} right={right} avg={mean != null ? { text: format(mean), y: yOf(mean) } : undefined}>
      {runs.filter((r) => r.length).map((r, k) => {
        let pts = r;
        if (r.length === 1) { // a lone reading: a short dash so it is visible
          const [x = '0', y = '0'] = (r[0] ?? '').split(',');
          pts = [`${Math.max(0, +x - 3)},${y}`, `${Math.min(W, +x + 3)},${y}`];
        }
        return <polyline key={k} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={pts.join(' ')} />;
      })}
    </Frame>
  );
}

export interface Bar {
  total: number;
  errors: number;
}

/** Counts per minute; the failed part of a column is red. */
export function BarChart({ title, value, bars, left, right, max: scale }: { title: string; value?: ReactNode; bars: Bar[]; left: string; right: string; max?: number }) {
  const n = Math.max(1, bars.length);
  const bw = W / n;
  const max = Math.max(1, scale ?? 0, ...bars.map((b) => b.total));
  const mean = bars.length ? bars.reduce((a, b) => a + b.total, 0) / bars.length : null;
  return (
    <Frame title={title} value={value} left={left} right={right} avg={mean != null ? { text: mean.toFixed(1), y: H - (mean / max) * (H - 4) } : undefined}>
      {bars.map((b, k) => {
        if (!b.total) return null;
        const bh = Math.max(2, (b.total / max) * (H - 4));
        const eh = (b.errors / b.total) * bh;
        const x = (k * bw + 0.5).toFixed(1);
        const w = Math.max(1, bw - 1).toFixed(1);
        return (
          <g key={k}>
            <rect x={x} y={(H - bh).toFixed(1)} width={w} height={(bh - eh).toFixed(1)} fill="var(--accent)" />
            {eh > 0 && <rect x={x} y={(H - eh).toFixed(1)} width={w} height={eh.toFixed(1)} fill="var(--err)" />}
          </g>
        );
      })}
    </Frame>
  );
}
