// Validation check: syntax-load every function, run the JARVIS sandbox once on sample data, check the static sandbox build.
// npm run validate
import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_MODE = 'sample';
const dir = new URL('../netlify/functions/', import.meta.url);
for (const name of (await readdir(dir)).filter(file => file.endsWith('.mjs'))) {
  const mod = await import(new URL(name, dir));
  if (typeof mod.default !== 'function' || !mod.config) throw new Error(name + ' is missing a handler or config');
}
const { report } = await import('../netlify/functions/lib/report.mjs');
const { runPlan, sandboxTables, validatePlan } = await import('../netlify/functions/lib/jarvis-sandbox.mjs');
const checked = validatePlan({ task: 'Validate', steps: [{ action: 'Run Query', sql: 'SELECT stage, count FROM funnel' }] });
const result = await runPlan(checked.plan, sandboxTables(await report({ preset: 'mtd' })));
if (result.outcome !== 'passed' || result.steps[0].rows.length !== 3) throw new Error('JARVIS sandbox check failed');
const out = join(tmpdir(), 'a2z-sandbox-validate.html');
execFileSync(process.execPath, [new URL('./build-sandbox.mjs', import.meta.url).pathname, out], { stdio: 'pipe' });
console.log('Validation passed: functions load, sandbox SQL runs, static preview builds.');
