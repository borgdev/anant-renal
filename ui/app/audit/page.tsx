import { runDemoReplay } from '@/lib/demo-data';

export default function AuditPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Audit ledger</h1>
      <div className="hh-card">
        <div className="hh-kv"><span className="k">Chain valid</span><span>{demo.auditValid ? 'yes' : 'no'}</span></div>
        <div className="hh-kv"><span className="k">Entries</span><span>{demo.audit.length}</span></div>
      </div>
      <div className="hh-card">
        <table className="hh-table">
          <thead><tr><th>#</th><th>Action</th><th>Actor</th><th>Hash</th></tr></thead>
          <tbody>
            {demo.audit.map((a) => (
              <tr key={a.sequence}><td>{a.sequence}</td><td>{a.action}</td><td>{a.actorId}</td><td><code>{a.hash}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
