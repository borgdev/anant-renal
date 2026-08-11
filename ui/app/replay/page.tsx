import { runDemoReplay } from '@/lib/demo-data';

export default function ReplayPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Replay viewer</h1>
      <div className="hh-card">
        <h2>Batch summary</h2>
        <div className="hh-kv"><span className="k">Events</span><span>{demo.eventCount}</span></div>
        <div className="hh-kv"><span className="k">Emitted signals</span><span>{demo.emittedCount}</span></div>
        <div className="hh-kv"><span className="k">Cases opened</span><span>{demo.caseCount}</span></div>
        <div className="hh-kv"><span className="k">Worst DQ severity</span><span>{demo.worstSeverity ?? 'clean'}</span></div>
      </div>
      <div className="hh-card">
        <h2>Measure evaluations</h2>
        <table className="hh-table">
          <thead><tr><th>Measure</th><th>Numerator</th><th>Denominator</th><th>Score</th></tr></thead>
          <tbody>
            {demo.measures.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td>{m.numerator ?? '—'}</td>
                <td>{m.denominator ?? '—'}</td>
                <td>{m.score === undefined ? '—' : `${(m.score * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
