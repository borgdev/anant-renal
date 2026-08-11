import { runDemoReplay } from '@/lib/demo-data';

export default function Home() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Healthcare Harness</h1>
      <div className="hh-card">
        <h2>What this is</h2>
        <p>Model-agnostic, hypergraph-native harness that compiles healthcare intent + local data into deployable, auditable applications. Dialysis is the reference implementation; core is generic across provider, payer, health-system, and practice organizations.</p>
      </div>
      <div className="hh-grid">
        <div className="hh-card">
          <h2>Replay snapshot</h2>
          <div className="hh-kv"><span className="k">Events processed</span><span>{demo.eventCount}</span></div>
          <div className="hh-kv"><span className="k">Emitted signals</span><span>{demo.emittedCount}</span></div>
          <div className="hh-kv"><span className="k">Missed-treatment cases</span><span>{demo.caseCount}</span></div>
          <div className="hh-kv"><span className="k">Worst DQ severity</span><span>{demo.worstSeverity ?? 'clean'}</span></div>
          <div className="hh-kv"><span className="k">Audit chain valid</span><span>{demo.auditValid ? 'yes' : 'no'}</span></div>
        </div>
        <div className="hh-card">
          <h2>Registered packs</h2>
          {demo.packs.map((p) => (
            <div key={p.id} className="hh-kv"><span className="k">{p.id}</span><span>{p.version}</span></div>
          ))}
        </div>
        <div className="hh-card">
          <h2>Quality measures</h2>
          {demo.measures.map((m) => (
            <div key={m.id} className="hh-kv">
              <span className="k">{m.id}</span>
              <span>{m.score === undefined ? '—' : `${(m.score * 100).toFixed(0)}%`}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
