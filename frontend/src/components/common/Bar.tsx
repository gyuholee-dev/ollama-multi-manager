/** One part of a bar: [name, percent of the bar, colour, text shown in the legend]. */
export type Segment = [name: string, percent: number, color: string, label: string];

/** A horizontal bar made of coloured parts. A part of zero width is left out (its gap would show as a notch). */
export function Bar({ segments }: { segments: Segment[] }) {
  return (
    <div className="bar">
      {segments.filter((s) => s[1] > 0).map((s, n) => <i key={`${n}-${s[0]}`} title={s[0]} style={{ width: `${s[1]}%`, background: s[2] }} />)}
    </div>
  );
}

export function Legend({ segments }: { segments: Segment[] }) {
  return (
    <div className="leg">
      {segments.map((s, n) => <span key={`${n}-${s[0]}`}><s style={{ background: s[2] }} />{s[0]} {s[3]}</span>)}
    </div>
  );
}
