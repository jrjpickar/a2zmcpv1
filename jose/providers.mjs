const adapters = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: 'JOSE_OPENROUTER_KEY',
    valid: model => /^[\w.-]+\/[\w.-]+:free$/.test(model),
    options: { provider: { allow_fallbacks: false, data_collection: 'deny', zdr: true,
      max_price: { prompt: 0, completion: 0, request: 0 } } },
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: 'JOSE_GROQ_FREE_KEY',
    valid: model => /^[\w./-]+$/.test(model),
    options: {},
  },
};

export function routes(config, env) {
  return (config.models || []).filter(entry => {
    if (!Object.hasOwn(adapters, entry.provider)) return false;
    const adapter = adapters[entry.provider];
    return adapter.valid(entry.model) && env[adapter.key] &&
      (entry.provider !== 'groq' || env.JOSE_GROQ_UNBILLED === 'yes') &&
      (entry.profiles === undefined || (Array.isArray(entry.profiles) &&
        entry.profiles.every(profile => typeof profile === 'string'))) &&
      (entry.rank === undefined || Number.isSafeInteger(entry.rank)) &&
      ['rpm', 'rpd', 'tpm', 'tpd', 'context'].every(key =>
        Number.isSafeInteger(entry[key]) && entry[key] > 0) &&
      (entry.provider !== 'openrouter' || (entry.rpm <= 20 && entry.rpd <= 50));
  }).sort((a, b) => (a.rank || 0) - (b.rank || 0) ||
    routeId(a).localeCompare(routeId(b)));
}

export const routeId = route => route.provider + ':' + route.model;

export async function complete(route, task, env, signal, fetchImpl) {
  const adapter = adapters[route.provider];
  const response = await fetchImpl(adapter.url, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: 'Bearer ' + env[adapter.key], 'content-type': 'application/json' },
    body: JSON.stringify({ model: route.model, max_tokens: 512,
      messages: [
        { role: 'system', content: 'Task profile: ' + task.profile +
          '. Provide a text answer using the submitted public information. Mark assumptions and never claim to have executed actions.' },
        { role: 'user', content: task.prompt },
      ], ...adapter.options }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    throw Object.assign(new Error('Provider HTTP ' + response.status), {
      status: response.status,
      retryMs: retry === null ? 0 : (isNaN(Number(retry)) ? Date.parse(retry) - Date.now() : Number(retry) * 1000),
    });
  }
  const data = await response.json();
  const result = data.choices?.[0]?.message?.content;
  if (typeof result !== 'string' || !result.trim()) throw new Error('Provider returned no text');
  return { result: result.slice(0, 12000), tokens: Number.isSafeInteger(data.usage?.total_tokens) && data.usage.total_tokens >= 0
    ? data.usage.total_tokens : null };
}
