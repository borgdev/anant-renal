import { consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export async function renderLiquidScore() {
  const dom = await consoleDomain();
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Score labs</h2>
      <p class="page-sub">Check a patient's projected labs against a CMS quality measure to see whether they qualify — no manual math.
      A hypertensive patient with these values should land in the numerator.</p></div></div>
    <div class="detail" style="margin-top:0;">
      <div class="field" style="max-width:340px;margin-bottom:10px;"><span>Measure</span><input id="ls-measure" value="${esc(dom.domainOptions.defaultMeasureId)}"></div>
      <div style="font-size:12px;font-weight:600;color:var(--muted);margin:0 0 8px;">Patient labs (projected from the trajectory model)</div>
      <div class="field-row">
        <label class="field"><span>Patient id</span><input id="ls-pid" value="p-htn" style="width:120px"></label>
        <label class="field"><span>K (mmol/L)</span><input id="ls-k" type="number" step="0.1" value="${esc(dom.domainOptions.demoLabs.k)}" style="width:80px"></label>
        <label class="field"><span>HGB (g/dL)</span><input id="ls-hgb" type="number" step="0.1" value="${esc(dom.domainOptions.demoLabs.hgb)}" style="width:80px"></label>
        <label class="field"><span>URR (%)</span><input id="ls-urr" type="number" step="1" value="${esc(dom.domainOptions.demoLabs.urr)}" style="width:80px"></label>
        <label class="field"><span>PHOS (mg/dL)</span><input id="ls-phos" type="number" step="0.1" value="${esc(dom.domainOptions.demoLabs.phos)}" style="width:80px"></label>
        <label class="field checkbox"><input id="ls-htn" type="checkbox" checked> Hypertension</label>
        <button class="btn btn-primary" id="ls-score"><i data-lucide="flask-conical"></i> Score</button>
      </div>
    </div>
    <div class="cards" style="grid-template-columns: repeat(2,1fr);">
      <div class="stat-card"><div class="num" id="ls-met">—</div><div class="lbl">Measure met</div></div>
      <div class="stat-card"><div class="num" id="ls-scored">—</div><div class="lbl">Scored</div></div>
    </div>
    <pre id="ls-out" class="detail" style="background:var(--code-bg);color:var(--code-fg);padding:12px;border-radius:8px;white-space:pre-wrap;"></pre>`;
  document.getElementById('ls-score')?.addEventListener('click', async () => {
    const out = document.getElementById('ls-out');
    const patients = [{
      id: document.getElementById('ls-pid').value || 'p1',
      labs: {
        K: Number(document.getElementById('ls-k').value), HGB: Number(document.getElementById('ls-hgb').value),
        URR: Number(document.getElementById('ls-urr').value), PHOS: Number(document.getElementById('ls-phos').value),
      },
      ...(document.getElementById('ls-htn').checked ? { hypertension: true } : {}),
    }];
    try {
      const res = await fetch('/admin/liquid/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ measureId: document.getElementById('ls-measure').value || dom.domainOptions.defaultMeasureId, patients }) });
      const d = await res.json();
      document.getElementById('ls-scored').textContent = d.scored ? 'yes' : d.reason || 'no';
      if (d.scored) {
        const p = d.patients[0];
        document.getElementById('ls-met').textContent = p ? (p.met ? 'met' : 'not met') : '—';
        out.textContent = JSON.stringify(d, null, 2);
      } else {
        out.textContent = JSON.stringify(d, null, 2);
      }
    } catch (err) { out.textContent = 'error: ' + String(err); }
  });
}
