import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Syntax gate for the operator console.
 *
 * A syntax error in the console's main script does not degrade the page — it
 * kills the whole boot (`initApp is not defined` in the separate boot block), so
 * this has to be cheap enough to run on every edit and must cover EVERY script
 * the console evaluates.
 *
 * Since S1 the bulk of the console lives in external files under admin-ui/js/,
 * so this checks both: the classic inline blocks still in index.html (the
 * pre-paint theme bootstrap and the Tailwind config) AND every file the HTML
 * references with a local src. A split that moved code into a file nobody
 * syntax-checked would otherwise be a silent hole.
 */
const htmlPath = fileURLToPath(new URL('../admin-ui/index.html', import.meta.url));
const html = readFileSync(htmlPath, 'utf8');

let checked = 0;
let failed = 0;

const fail = (label, msg) => {
  failed += 1;
  console.log(`SYNTAX ERROR in ${label}: ${String(msg).split('\n')[0]}`);
};

/** Parse (never execute) a classic script body. */
const checkClassic = (label, code) => {
  checked += 1;
  try { new Function(code); } catch (e) { fail(label, e.message); }
};

/** Validate ESM syntax without executing it (`node --check` accepts import/export). */
const checkModule = (label, code) => {
  checked += 1;
  const tmp = join(tmpdir(), `hh-syntax-${process.pid}-${checked}.mjs`);
  try {
    writeFileSync(tmp, code);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fail(label, e.stderr?.toString() || e.message);
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
};

// 1. Inline classic blocks (skips src= and type="module").
const inline = /<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g;
let m;
let i = 0;
while ((m = inline.exec(html))) {
  i += 1;
  checkClassic(`index.html inline block #${i}`, m[1]);
}

// 2. Every locally-referenced external script (skip CDN/protocol URLs).
const localSrcs = [];
const srcRe = /<script[^>]*\bsrc="([^"]+)"/g;
while ((m = srcRe.exec(html))) {
  const url = m[1];
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
  localSrcs.push(url);
}

for (const url of localSrcs) {
  const path = fileURLToPath(new URL(`../admin-ui/${url.replace(/^\.\//, '')}`, import.meta.url));
  if (!existsSync(path)) {
    failed += 1;
    console.log(`MISSING FILE referenced by index.html: ${url}`);
    continue;
  }
  const code = readFileSync(path, 'utf8');
  if (/^\s*(import|export)\s/m.test(code)) checkModule(url, code);
  else checkClassic(url, code);
}

console.log(
  failed === 0
    ? `ALL ${checked} scripts OK (${i} inline + ${localSrcs.length} external: ${localSrcs.join(', ')})`
    : `FAILED — ${failed} of ${checked} scripts`,
);
process.exit(failed === 0 ? 0 : 1);

