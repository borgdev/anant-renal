import { runDemoReplay } from '@/lib/demo-data';

export default function PacksPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Pack registry</h1>
      <div className="hh-card">
        <table className="hh-table">
          <thead><tr><th>Pack</th><th>Version</th></tr></thead>
          <tbody>
            {demo.packs.map((p) => (
              <tr key={p.id}><td>{p.id}</td><td>{p.version}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
