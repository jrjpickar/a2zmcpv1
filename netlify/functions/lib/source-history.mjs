// Source uptime history (pattern from Uptime Kuma heartbeats). One sample per source per alert check, last 288 kept.
// State per source: up, pending (failing, under SOURCE_DOWN_AFTER misses), down. Default SOURCE_DOWN_AFTER is 1.
export const HISTORY_KEY = 'sources/history';
const MAX_SAMPLES = 288;

export function addSamples(history, sources, at) {
  const out = history && typeof history === 'object' ? history : {};
  for (const [name, source] of Object.entries(sources || {})) {
    if (source.status === 'setup') continue;
    const list = Array.isArray(out[name]) ? out[name] : [];
    list.push([at, source.status === 'ok' ? 1 : 0, Number.isFinite(source.ms) ? source.ms : null]);
    out[name] = list.slice(-MAX_SAMPLES);
  }
  return out;
}

export function sourceState(samples, downAfter = 1) {
  if (!samples?.length) return null;
  let misses = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i][1] === 0; i--) misses++;
  const since = Date.now() - 24 * 3600000;
  const day = samples.filter(sample => Date.parse(sample[0]) >= since);
  return {
    state: misses === 0 ? 'up' : misses >= Math.max(1, downAfter) ? 'down' : 'pending',
    misses,
    uptime24h: day.length ? Math.round(day.reduce((total, sample) => total + sample[1], 0) / day.length * 1000) / 10 : null,
    checks24h: day.length,
  };
}
