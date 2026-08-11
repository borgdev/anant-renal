import { runDemoReplay } from '@/lib/demo-data';

export default function MeasuresPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Quality measures</h1>
      <div className="hh-card">
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
