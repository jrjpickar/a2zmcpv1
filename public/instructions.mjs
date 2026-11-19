// Custom instructions form (like ChatGPT or Claude). Used in the city and the JARVIS tab.
// Text nodes only. No inline styles (the site CSP is style-src 'self').
const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children.filter(Boolean)); return n; };

export function instructionsForm({ headers, onSaved = () => {} }) {
  const about = el('textarea', { rows: 5, maxLength: 1500, placeholder: 'e.g. I run systems and estimating at A2Z, a demolition subcontractor in Costa Mesa. I care most about bids, crews and cash.' });
  const style = el('textarea', { rows: 5, maxLength: 1500, placeholder: 'e.g. Lead with the answer. Short bullets. Numbers over adjectives. No em dashes. Ask before assuming.' });
  const enabled = el('input', { type: 'checkbox', checked: true });
  const status = el('p', { className: 'muted', role: 'status' });
  const save = el('button', { type: 'submit', className: 'primary' }, 'Save');
  const count = area => { const c = el('small', { className: 'muted instr-count' }); const draw = () => { c.textContent = area.value.length + ' / 1500'; }; area.addEventListener('input', draw); draw(); return { c, draw }; };
  const aboutCount = count(about), styleCount = count(style);
  const form = el('form', { className: 'instr-form' },
    el('p', { className: 'muted' }, 'Every agent reads these on every reply: the city robots, the JARVIS tab, Slack, Groq, Gemini and Workers AI. Company rules and safety rules still come first.'),
    el('label', { className: 'instr-field' }, el('span', {}, 'What should JARVIS know about you?'), about, aboutCount.c),
    el('label', { className: 'instr-field' }, el('span', {}, 'How should JARVIS respond?'), style, styleCount.c),
    el('label', { className: 'instr-toggle' }, enabled, el('span', {}, 'Use these instructions')),
    el('div', { className: 'instr-actions' }, save), status);
  const request = async (method, body) => {
    const response = await fetch('/api/jarvis-instructions', { method, headers: headers(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Instructions unavailable (HTTP ' + response.status + ').');
    return data;
  };
  const fill = data => {
    about.value = data.about || ''; style.value = data.style || ''; enabled.checked = data.enabled !== false;
    aboutCount.draw(); styleCount.draw();
    status.textContent = data.updatedAt ? 'Last saved ' + new Date(data.updatedAt).toLocaleString() : '';
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true; status.textContent = 'Saving…';
    try { const data = await request('POST', { about: about.value, style: style.value, enabled: enabled.checked }); fill(data); status.textContent = 'Saved. Every agent uses these from the next message.'; onSaved(data); }
    catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  form.load = async () => { status.textContent = 'Loading…'; try { fill(await request('GET')); } catch (error) { status.textContent = error.message; } };
  return form;
}
