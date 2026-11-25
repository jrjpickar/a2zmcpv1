export function createRuntimePanel(headers) {
  const element = (tag, text = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const panel = element('section');
  panel.className = 'surface rule-group';
  const health = element('p');
  const message = element('p');
  message.setAttribute('role', 'status');
  const queue = element('ul');
  const feed = element('ul');
  const checks = element('ul');
  const catalog = element('ul');
  const tools = element('details');
  tools.append(element('summary', 'MCP tool catalog'), catalog);
  const providers = element('ul');
  const form = element('form');
  const profile = element('select');
  profile.setAttribute('aria-label', 'Task profile');
  const prompt = element('textarea');
  prompt.setAttribute('aria-label', 'Task prompt');
  prompt.placeholder = 'Describe a research, analysis, or drafting task';
  prompt.required = true;
  prompt.maxLength = 3000;

  function checkbox(label) {
    const wrapper = element('label');
    const input = element('input');
    input.type = 'checkbox';
    wrapper.append(input, ' ' + label);
    return { wrapper, input };
  }

  const publicData = checkbox('This prompt contains only public, non-sensitive information');
  publicData.input.required = true;
  const approval = checkbox('Hold for approval');
  const submit = element('button', 'Queue task');
  submit.type = 'submit';
  const stop = element('button', 'Emergency stop');
  stop.type = 'button';
  form.append(profile, prompt, publicData.wrapper, approval.wrapper, submit);
  panel.append(element('h2', 'JOSE command center'), health, message, form, stop,
    element('h3', 'Tasks'), queue, element('h3', 'Providers'), providers,
    element('h3', 'Monitors'), checks, tools, element('h3', 'Execution feed'), feed);
  form.hidden = stop.hidden = true;

  let busy = false;
  let stopped = false;
  let lastState = '';
  let pending = null;

  async function request(input) {
    const response = await fetch('/api/jose-runtime', input ? {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(input),
    } : { headers: headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'JOSE runtime unavailable');
    return data;
  }

  function render(data) {
    if (pending && data.relayReceipt?.id === pending.id) {
      message.textContent = data.relayReceipt.status < 400 ? 'JOSE applied the command.' : 'JOSE rejected the command.';
      pending = null;
    } else if (pending && Date.now() > pending.deadline) {
      message.textContent = 'JOSE did not confirm the command. Check the execution feed before retrying.';
      pending = null;
    }
    health.textContent = [
      data.stopped ? 'Stopped' : 'Online', 'Uptime ' + data.uptimeSeconds + 's',
      'JOSE RAM ' + Math.round(data.rssMiB) + ' MiB',
      'Host free RAM ' + Math.round(data.hostFreeMiB) + ' MiB',
      'Load ' + data.loadAverage[0].toFixed(2),
      'MCP ' + data.tools.status + ' (' + data.tools.catalog.length + ' tools)',
      ...(data.gateway === 'unconfigured' ? [] : ['OpenClaw ' + data.gateway]),
      ...(data.configError ? ['Check runtime configuration'] : []),
    ].join(' · ');
    form.hidden = stop.hidden = false;
    stopped = data.stopped;
    stop.textContent = stopped ? 'Resume execution' : 'Emergency stop';
    if (!profile.options.length) profile.append(...data.profiles.map(name => element('option', name)));
    const signature = JSON.stringify([data.tasks, data.providers, data.monitors, data.tools.catalog, data.events]);
    if (signature === lastState) return;
    lastState = signature;
    queue.replaceChildren(...data.tasks.map(task => {
      const row = element('li');
      row.append(element('strong', task.status + ' · ' + task.profile), element('p', task.prompt));
      if (task.model) row.append(element('p', task.provider + ' / ' + task.model + ' · ' + task.reason));
      if (task.result) row.append(element('p', task.result));
      if (task.tokens != null) row.append(element('p', task.tokens + ' tokens reported'));
      for (const action of task.status === 'approval' ? ['approve', 'cancel']
        : ['queued', 'running'].includes(task.status) ? ['cancel'] : []) {
        const button = element('button', action === 'approve' ? 'Approve' : 'Cancel');
        button.addEventListener('click', () => update({ action, id: task.id }));
        row.append(button);
      }
      return row;
    }));
    providers.replaceChildren(...data.providers.map(route => element('li', [
      route.provider + ' / ' + route.model,
      Math.max(0, route.limits.rpd - route.accountUsage.requests) + ' local requests left today',
      Math.max(0, route.limits.tpd - route.modelUsage.tokens) + ' estimated local tokens left',
      Math.max(route.modelUsage.until || 0, route.accountUsage.until || 0) > Date.now() ? 'Cooling down' : 'Configured',
    ].join(' · '))));
    checks.replaceChildren(...Object.entries(data.monitors).map(([name, check]) =>
      element('li', name + ' · ' + (check.ok ? 'Healthy' : 'Failed'))));
    catalog.replaceChildren(...data.tools.catalog.map(tool => element('li', [
      tool.name, tool.description, tool.required.length ? 'Required ' + tool.required.join(', ') : '',
    ].filter(Boolean).join(' · '))));
    feed.replaceChildren(...data.events.slice(0, 20).map(event =>
      element('li', new Date(event.at).toLocaleTimeString() + ' · ' + event.type +
        (event.taskId ? ' · ' + event.taskId.slice(0, 8) : ''))));
  }

  async function update(input) {
    if (busy) return false;
    busy = true;
    let saved = false;
    try {
      if (input) {
        const result = await request(input);
        saved = true;
        if (result.id) pending = { id: result.id, deadline: Date.now() + 120000 };
        message.textContent = result.accepted ? 'Sent to JOSE. Waiting for the worker.' : 'Saved';
      }
      render(await request());
    } catch (error) {
      if (input) message.textContent = saved ? 'Saved. Status refresh failed.' : error.message;
      else health.textContent = error.message;
    } finally { busy = false; }
    return saved;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    if (await update({ action: 'submit', prompt: prompt.value, profile: profile.value,
      publicData: publicData.input.checked, approval: approval.input.checked })) {
      prompt.value = '';
      publicData.input.checked = false;
    }
    submit.disabled = false;
  });
  stop.addEventListener('click', () => update({ action: stopped ? 'resume' : 'stop' }));
  setInterval(() => {
    if (panel.isConnected && !panel.closest('[hidden]') && !document.hidden) update();
  }, 5000);
  panel.load = () => update();
  return panel;
}
