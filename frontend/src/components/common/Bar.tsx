/**
 * One part of a bar: [name, percent of the bar, colour, text shown in the legend, kind].
 * kind 'gap' is room left empty inside the bar (transparent, not listed in the legend); kind 'mark' is only a legend entry
 * for the marker drawn on the bar (see `marker`).
 */
export type Segment = [name: string, percent: number, color: string, label: string, kind?: 'gap' | 'mark'];

/**
 * A horizontal bar made of coloured parts. A part of zero width is left out (its gap would show as a notch).
 * `off` draws the bar disabled: there is nothing to show (the reading is not supported).
 * `marker` draws a thin line at that percent of the bar (a limit).
 */
export function Bar({ segments, off, marker }: { segments: Segment[]; off?: boolean; marker?: number }) {
  return (
    <div className={off ? 'bar off' : 'bar'}>
      {segments.filter((s) => s[1] > 0 && s[4] !== 'mark').map((s, n) => <i key={`${n}-${s[0]}`} title={s[0]} style={{ width: `${s[1]}%`, background: s[2] }} />)}
      {marker != null && marker > 0 && marker < 100 && <u className="mk" style={{ left: `${marker}%` }} />}
    </div>
  );
}

export function Legend({ segments }: { segments: Segment[] }) {
  return (
    <div className="leg">
      {segments.filter((s) => s[4] !== 'gap').map((s, n) => <span key={`${n}-${s[0]}`}><s className={s[4] === 'mark' ? 'mk' : undefined} style={{ background: s[2] }} />{s[0]} {s[3]}</span>)}
    </div>
  );
}
