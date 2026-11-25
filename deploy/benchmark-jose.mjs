import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../jose/runtime.mjs';

const dir = mkdtempSync(join(tmpdir(), 'a2z-jose-bench-'));
const config = join(dir, 'config.json');
writeFileSync(config, JSON.stringify({ models: [{
  provider: 'openrouter', model: 'mock/model:free', context: 4000,
  rpm: 20, rpd: 50, tpm: 50000, tpd: 1000000,
}] }));
const token = 'local-benchmark-only-no-live-token';
const runtime = createRuntime({ JOSE_TOKEN: token, JOSE_STATE_DIR: dir,
  JOSE_CONFIG: config, JOSE_OPENROUTER_KEY: 'mock' }, async () => {
  await new Promise(resolve => setTimeout(resolve, 30));
  return Response.json({ choices: [{ message: { content: 'Mock result' } }], usage: { total_tokens: 47 } });
});
try {
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const url = 'http://127.0.0.1:' + runtime.server.address().port + '/jose';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  await runtime.tick();
  const idle = runtime.status().rssMiB;
  const rejected = await fetch(url);
  if (rejected.status !== 401) throw new Error('Unauthenticated request accepted');
  await rejected.arrayBuffer();
  let peak = idle;
  for (let i = 0; i < 10; i++) {
    const response = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ action: 'submit', profile: 'research', publicData: true, prompt: 'Public sample' }) });
    if (response.status !== 201) throw new Error('Task submission failed');
    await response.json();
    const tick = runtime.tick();
    const poll = await fetch(url, { headers });
    const status = await poll.json();
    peak = Math.max(peak, status.rssMiB);
    await tick;
    peak = Math.max(peak, runtime.status().rssMiB);
  }
  const completed = runtime.status().tasks.filter(task => task.status === 'completed').length;
  if (completed !== 10) throw new Error('Unexpected completion count');
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    idleMiB: +idle.toFixed(1), activeSampledPeakMiB: +peak.toFixed(1), completed,
    transport: 'local HTTP', inference: 'mocked' }, null, 2));
} finally {
  runtime.server.close();
  rmSync(dir, { recursive: true, force: true });
}
