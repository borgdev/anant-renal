/** Console auth helpers — same session cookie the ops console uses (/auth/*). */

export interface MeUser {
  username: string;
  displayName: string;
  role: string;
  clearance: string;
  purposeOfUse: string[];
}

export type MeResult =
  | { authenticated: true; user: MeUser }
  | { authenticated: false; unreachable?: boolean };

/**
 * Ask the server who we are.
 *
 * A 401 is a definitive "you are anonymous" — show the login screen. Anything
 * else (network refused, 5xx, a dev-server reload) is "we cannot tell yet", and
 * treating that as anonymous is what made a console look like it had lost the
 * other console's login during a restart. Those cases retry briefly and, if they
 * still fail, report `unreachable` so the gate reconnects instead of demanding a
 * fresh sign-in.
 */
export async function fetchMe(): Promise<MeResult> {
  const delays = [0, 500, 1200];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const wait = delays[attempt] ?? 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) return { authenticated: false };
      if (!response.ok) continue;
      const payload = (await response.json()) as { authenticated?: boolean; user?: MeUser };
      return payload.authenticated && payload.user
        ? { authenticated: true, user: payload.user }
        : { authenticated: false };
    } catch {
      // network-level failure — the server is probably restarting; retry
    }
  }
  return { authenticated: false, unreachable: true };
}

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: payload.error ?? "Sign-in failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Sign-in failed" };
  }
}

export async function logout(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: payload.error ?? "Sign-out failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Sign-out failed" };
  }
}
