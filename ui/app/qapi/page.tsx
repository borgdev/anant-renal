import { runDemoReplay } from '@/lib/demo-data';

const COLUMNS = ['identified', 'investigating', 'intervening', 'monitoring', 'closed'] as const;

export default function QapiPage() {
  const demo = runDemoReplay();
  // Synthesize QAPI cases from missed-treatment case counts to keep the demo self-contained.
  const board: Record<(typeof COLUMNS)[number], string[]> = {
    identified: demo.cases.slice(0, 1).map((c) => `${c.id} · ${c.reason ?? 'unknown'}`),
    investigating: demo.cases.slice(1, 2).map((c) => c.id),
    intervening: [],
    monitoring: [],
    closed: [],
  };
  return (
    <>
      <h1>QAPI board</h1>
      <div className="hh-grid">
        {COLUMNS.map((col) => (
          <div key={col} className="hh-card">
            <h2>{col}</h2>
            {board[col].length === 0 ? <p>—</p> : board[col].map((c) => <div key={c} className="hh-kv"><span>{c}</span></div>)}
          </div>
        ))}
      </div>
    </>
  );
}
