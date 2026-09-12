import { useEffect, useState } from "react";
import { Activity, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { login } from "../lib/auth";

const QUICK_USERS = [
  { username: "admin", password: "admin123", label: "Console Administrator", tone: "mint", role: "admin" },
  { username: "nurse", password: "nurse123", label: "Nurse Clinician", tone: "blue", role: "nurse" },
  { username: "auditor", password: "audit123", label: "Compliance Auditor", tone: "amber", role: "auditor" },
] as const;

/** Exec console is for admin | md | safety — the ops-only roles (nurse/auditor/etc.)
 *  would be denied by the server gate, so never offer them as quick users here. */
const EXEC_ROLES: readonly string[] = ["admin", "md", "safety"];
const EXEC_ONLY_USERS = QUICK_USERS.filter((u) => EXEC_ROLES.includes(u.role));

type QuickUser = (typeof QUICK_USERS)[number];

function friendlyError(raw: string): string {
  if (raw === "invalid-credentials") return "Invalid username or password. Demo sign-in: admin / admin123.";
  if (raw === "username-and-password-required") return "Enter your username and password.";
  return raw;
}

export default function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickUsers, setQuickUsers] = useState<readonly QuickUser[]>(EXEC_ONLY_USERS);

  // Reconcile the offered quick users with the server's console-role map so a
  // future exec-role user (e.g. an md) is offered when the server allows it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let execRoles: readonly string[] = EXEC_ROLES;
      try {
        const res = await fetch("/admin/console-access", { credentials: "include" });
        if (res.ok) {
          const data = (await res.json()) as { all?: Record<string, string[]> };
          const exec = data.all?.exec;
          if (exec && exec.length) execRoles = exec;
        }
      } catch {
        // Offline / server down — keep the static exec-only fallback.
      }
      if (!cancelled) setQuickUsers(QUICK_USERS.filter((u) => execRoles.includes(u.role)));
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(user = username, pass = password) {
    if (!user.trim() || !pass) { setError("Enter your username and password."); return; }
    setBusy(true);
    setError(null);
    const result = await login(user, pass);
    setBusy(false);
    if (result.ok) {
      onAuthed();
    } else {
      setError(friendlyError(result.error));
    }
  }

  return (
    <div className="exec-login">
      <div className="exec-login-card">
        <div className="exec-login-brand">
          <span className="brand-mark"><Activity size={22} aria-hidden="true" /></span>
          <div><strong>AnantHealth</strong></div>
        </div>
        <h1>Sign in to the executive console</h1>
        <p className="exec-login-sub">Role and scope are enforced server-side — the browser never grants authority.</p>

        <form className="exec-login-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label><span>Username</span>
            <input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="admin" autoComplete="off" />
          </label>
          <label><span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" autoComplete="off" />
          </label>
          {error ? <p className="exec-login-error">{error}</p> : null}
          <button className="exec-login-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="is-spinning" size={16} /> : <LockKeyhole size={16} />} Sign in
          </button>
        </form>

        <div className="exec-login-quick">
          <span>{quickUsers.length ? `Quick demo users · ${quickUsers.map((u) => `${u.username} / ${u.password}`).join(" · ")}` : "Sign in with your account"}</span>
          <div>
            {quickUsers.map((user) => (
              <button key={user.username} type="button" disabled={busy} onClick={() => { setUsername(user.username); setPassword(user.password); void submit(user.username, user.password); }}>
                <strong>{user.username}</strong><small>{user.label}</small>
              </button>
            ))}
          </div>
        </div>

        <p className="exec-login-foot"><ShieldCheck size={13} /> Local console auth · enterprise SSO via Identity providers.</p>
      </div>
    </div>
  );
}
