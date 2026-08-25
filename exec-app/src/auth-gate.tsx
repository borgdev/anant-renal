import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import AppShell from "./app";
import LoginScreen from "./components/login-screen";
import { fetchMe, logout, type MeUser } from "./lib/auth";
import { loadCatalogs } from "./lib/catalogs";

/** Boot gate — mirrors the ops console: check /auth/me, show login when anon. */
export default function AuthGate() {
  const [status, setStatus] = useState<"loading" | "authed" | "anon">("loading");
  const [user, setUser] = useState<MeUser | null>(null);

  useEffect(() => {
    let active = true;
    void fetchMe().then((result) => {
      if (!active) return;
      if (!result.authenticated) { setStatus("anon"); return; }
      setUser(result.user);
      // Load every backend catalog before the shell mounts — the frontend holds
      // zero synthetic data, so the app must not render until catalogs resolve.
      void loadCatalogs().catch(() => undefined).then(() => { if (active) setStatus("authed"); });
    });
    return () => { active = false; };
  }, []);

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
  if (status === "anon") return <LoginScreen onAuthed={finishAuth} />;
  return <AppShell user={user} onLogout={handleLogout} />;
}
