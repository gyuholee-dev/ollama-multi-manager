/** Memory (RAM, VRAM) is shown in GiB (2^30 bytes) with the label "GB": that is what the operating systems show for memory. */
export const GiB = 2 ** 30;

export const gb = (bytes: number | null | undefined): number => (bytes || 0) / GiB;

/** Model and storage sizes are decimal (10^9 bytes), as Ollama shows them (`ollama list`); the same bytes in GiB are given beside them. */
export const GB = 1e9;
export const gbDecimal = (bytes: number | null | undefined): number => (bytes || 0) / GB;

const MB = 1e6;
const MiB = 2 ** 20;

/** "986 MB" below 1 GB, "8.0 GB" from there on (rounding up to 1000 MB counts as 1.0 GB). */
function scale(bytes: number, small: number, big: number, smallName: string, bigName: string): string {
  if (bytes >= big || Math.round(bytes / small) >= 1000) return `${(bytes / big).toFixed(1)} ${bigName}`;
  return `${Math.round(bytes / small)} ${smallName}`;
}

/** A file or storage size twice: `main` in 10^9 bytes (GB, MB) and `alt` in 2^30 bytes (GiB, MiB); `alt` is empty below 1 MB. */
export function fileSize(bytes: number | null | undefined): { main: string; alt: string } {
  const b = Math.max(0, bytes || 0);
  if (b < MB) return { main: `${Math.round(b)} B`, alt: '' };
  return { main: scale(b, MB, GB, 'MB', 'GB'), alt: scale(b, MiB, GiB, 'MiB', 'GiB') };
}

/** For a place with room: "8.0 GB (7.5 GiB)". */
export function sizeBoth(bytes: number | null | undefined): string {
  const { main, alt } = fileSize(bytes);
  return alt ? `${main} (${alt})` : main;
}

/** For a tight place: "8.0 GB" (the GiB value goes in `sizeTitle`, shown when the pointer rests on it). */
export const sizeText = (bytes: number | null | undefined): string => fileSize(bytes).main;
export const sizeTitle = (bytes: number | null | undefined): string | undefined => fileSize(bytes).alt || undefined;
