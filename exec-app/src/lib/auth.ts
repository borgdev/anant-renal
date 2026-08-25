/** Console auth helpers — same session cookie the ops console uses (/auth/*). */

export interface MeUser {
  username: string;
  displayName: string;
  role: string;
  clearance: string;
  purposeOfUse: string[];
}

export type MeResult = { authenticated: true; user: MeUser } | { authenticated: false };

export async function fetchMe(): Promise<MeResult> {
  try {
    const response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return { authenticated: false };
    const payload = (await response.json()) as { authenticated?: boolean; user?: MeUser };
    return payload.authenticated && payload.user ? { authenticated: true, user: payload.user } : { authenticated: false };
  } catch {
    return { authenticated: false };
  }
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
