/** A Material Icons glyph (the font is bundled, so it works offline). */
export function Icon({ name }: { name: string }) {
  return <span className="material-icons">{name}</span>;
}
