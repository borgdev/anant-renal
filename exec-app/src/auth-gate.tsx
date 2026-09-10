import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import AppShell from "./app";
import LoginScreen from "./components/login-screen";
import { fetchMe, logout, type MeUser } from "./lib/auth";
import { loadCatalogs } from "./lib/catalogs";

/** Boot gate — mirrors the ops console: check /auth/me, show login when anon. *
 *
 * A server that cannot be reached is NOT the same as an anonymous visitor. Both
 * consoles share one `hh_session` cookie, so bouncing to the login screen on a
 * transient failure (a dev-server reload, a restart, a dropped request) reads as
 * "the other console invalidated my login". Instead the gate reconnects: it keeps
 * retrying in the background and enters the app as soon as the session resolves.
 */
export default function AuthGate() {
  const [status, setStatus] = useState<"loading" | "reconnecting" | "authed" | "anon">("loading");
  const [user, setUser] = useState<MeUser | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchMe().then((result) => {
      if (!active) return;
      if (result.authenticated) {
        setUser(result.user);
        // Load every backend catalog before the shell mounts — the frontend holds
        // zero synthetic data, so the app must not render until catalogs resolve.
        void loadCatalogs().catch(() => undefined).then(() => { if (active) setStatus("authed"); });
        return;
      }
      setStatus(result.unreachable ? "reconnecting" : "anon");
    });
    return () => { active = false; };
  }, []);

  // Reconnect loop: while the server is unreachable, retry — and if it answers
  // with a real session (the common case after a reload), go straight in.
  useEffect(() => {
    if (status !== "reconnecting") return;
    let active = true;
    const timer = setTimeout(() => {
      void fetchMe().then((result) => {
        if (!active) return;
        setAttempts((n) => n + 1);
        if (result.authenticated) {
          setUser(result.user);
          void loadCatalogs().catch(() => undefined).then(() => { if (active) setStatus("authed"); });
          return;
        }
        if (!result.unreachable) setStatus("anon");
      });
    }, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [status, attempts]);

  function finishAuth() {
    void fetchMe().then((result) => {
      if (result.authenticated) setUser(result.user);
    });
    void loadCatalogs().catch(() => undefined).then(() => setStatus("authed"));
  }

  function handleLogout() {
    void logout().finally(() => {
      setUser(null);
      setStatus("anon");
    });
  }

  if (status === "loading") {
    return (
      <div className="exec-login">
        <div className="exec-login-card exec-login-loading"><span className="is-spinning"><Activity size={20} /></span><p>Resolving session…</p></div>
      </div>
    );
  }
  if (status === "reconnecting") {
    return (
      <div className="exec-login">
        <div className="exec-login-card exec-login-loading">
          <span className="is-spinning"><Activity size={20} /></span>
          <p>Reconnecting to the harness…</p>
          <p className="exec-login-hint">
            Your session is still valid — the server is restarting. This page reconnects on its own.
          </p>
        </div>
      </div>
    );
  }
  if (status === "anon") return <LoginScreen onAuthed={finishAuth} />;
  return <AppShell user={user} onLogout={handleLogout} />;
}
