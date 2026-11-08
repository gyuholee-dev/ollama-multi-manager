// Thin client for the backend's REST API. The page is served by the backend itself, so requests are same-origin.
// Electron passes the session token in the URL fragment (#token=...), which is read once and then removed from the
// address bar. The token is kept in sessionStorage so a reload of the page (which no longer has the fragment) stays
// signed in. A guest page (web access) has no token at all.

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'omm-token';

function readToken(): string {
  const m = location.hash.match(/token=([^&]+)/);
  if (m?.[1]) {
    const token = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable: a reload will need the fragment again */ }
    history.replaceState(null, '', location.pathname + location.search);
    return token;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

let token = '';
let base = '';

/** Reads the token and the API base once, at startup. For a separately started backend open the page with ?api=http://127.0.0.1:8765 */
export function initClient(): void {
  token = readToken();
  base = new URLSearchParams(location.search).get('api') ?? location.origin;
}

/** The text to show for a failed response. FastAPI sends `detail`, the app's own errors send `error.message`. */
export function messageOf(data: unknown, fallback: string): string {
  const d = data as { error?: { message?: string }; detail?: unknown } | null;
  if (d?.error?.message) return d.error.message;
  if (typeof d?.detail === 'string') return d.detail;
  if (Array.isArray(d?.detail)) {
    return (d.detail as { loc?: unknown[]; msg: string }[]).map((x) => `${(x.loc ?? []).slice(1).join('.')}: ${x.msg}`).join('\n');
  }
  return fallback;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'Network error', 'network');
  }
  if (response.status === 204) return null as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (data as { error?: { code?: string } } | null)?.error?.code;
    throw new ApiError(response.status, messageOf(data, response.statusText), code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = null>(path: string) => request<T>('DELETE', path),
};

/** WebSocket URL of the live updates (same token, passed as a query parameter). */
export function socketUrl(): string {
  return `${base.replace(/^http/, 'ws')}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
