/* U #7 — shared session-expiry signalling for the exec console.
 *
 * Every fetch wrapper (harness/anemia/work/catalog) routes responses through
 * `responseOrThrow`, which tags 401s with `code: "unauthorized"` and calls
 * `notifySessionExpired()`. The app shell subscribes once and shows a single,
 * consistent "Session expired — sign in again" banner on ANY page — instead of
 * each panel rendering its own raw network error when the dev server restarts
 * and clears the in-memory session.
 */

export type SessionAwareError = Error & { code?: string; status?: number };

export function isSessionError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    const e = err as SessionAwareError;
    if (e.code === "unauthorized" || e.status === 401) return true;
    const m = (e.message ?? "").toLowerCase();
    return m.includes("not-authenticated") || m.includes("session expired") || m.includes("401");
  }
  return false;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to session-expiry events; returns an unsubscribe fn. */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Signal that the current session is no longer accepted by the server. */
export function notifySessionExpired(): void {
  for (const cb of [...listeners]) {
    try { cb(); } catch { /* a listener must never break the signal */ }
  }
}

/** Shared response handler for the fetch wrappers — tags + signals 401s. */
export async function responseOrThrow<T>(path: string, response: Response): Promise<T> {
  let payload: T & { error?: string };
  try {
    payload = (await response.json()) as T & { error?: string };
  } catch {
    payload = {} as T & { error?: string };
  }
  if (!response.ok) {
    const error = new Error(payload.error ?? `request failed: ${path}`) as SessionAwareError;
    error.status = response.status;
    if (response.status === 401) {
      error.code = "unauthorized";
      notifySessionExpired();
    }
    throw error;
  }
  return payload;
}
