import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../admin-ui/index.html', import.meta.url), 'utf8');
const re = /<script(?![^>]*src=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g;
let m;
let i = 0;
let ok = true;
while ((m = re.exec(html))) {
  i += 1;
  try {
    new Function(m[1]);
  } catch (e) {
    ok = false;
    console.log(`SYNTAX ERROR in script block #${i}:`, e.message);
  }
}
console.log(ok ? `ALL ${i} inline script blocks OK` : `FAILED at block ${i}`);
