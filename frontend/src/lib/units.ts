/** Bytes -> GiB (2^30). Model sizes and memory are shown in GiB throughout the app. */
export const GiB = 2 ** 30;

export const gb = (bytes: number | null | undefined): number => (bytes || 0) / GiB;
