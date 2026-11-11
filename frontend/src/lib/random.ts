/** The rule of every API key (an instance's, the metrics one): a typed one has at least this many characters, a generated one has 32. */
export const API_KEY_MIN = 16;

/** Random bytes as URL-safe text (base64url): 24 bytes = 32 characters, an API key. */
export const randomKey = (bytes = 24): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '');
};
