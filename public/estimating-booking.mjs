const outcomes = {
  new_opportunity: 'New opportunity',
  duplicate: 'Duplicate opportunity',
  rebid_warning: 'Closed opportunity found',
  multiple_gcs: 'Add to Multiple GCs Bidding',
};

const element = (tag, text = '') => Object.assign(document.createElement(tag), { textContent: text });

export function estimatingBooking(call) {
  const panel = element('details');
  panel.className = 'surface jarvis-learning';
  const form = element('form');
  const details = element('div');
  details.className = 'jarvis-plan';
  details.setAttribute('aria-live', 'polite');
  const fields = [
    ['address', 'Job address', 250], ['projectName', 'Project name', 120],
    ['companyName', 'GC company', 120], ['email', 'GC email', 160, 'email'],
    ['phone', 'GC phone', 20, 'tel'], ['firstName', 'Contact first name', 60],
    ['lastName', 'Contact last name', 60], ['dueDate', 'Bid due date', 10, 'date'],
  ];
  for (const [name, text, maxLength, type = 'text'] of fields) {
    const label = element('label', text + ' ');
    label.append(Object.assign(element('input'), { name, type, maxLength }));
    form.append(label);
  }
  const rebid = element('label', ' Explicitly confirm this is a rebid');
  rebid.prepend(Object.assign(element('input'), { name: 'rebid', type: 'checkbox' }));
  const check = Object.assign(element('button', 'Preview opportunity'), { type: 'submit' });
  form.append(rebid, check);
  panel.append(element('summary', 'Estimating opportunity'), form, details);
  const request = body => call('/api/jarvis/confirm', {
    method: 'POST', body: { action: 'create_opportunity', ...body },
  });
  form.oninput = () => details.replaceChildren();

  function show(preview, args) {
    details.replaceChildren(element('strong', outcomes[preview.outcome] || 'Opportunity preview'));
    if (preview.pipelineId) details.append(element('p', ['Pipeline ' + preview.pipelineId, preview.stage].filter(Boolean).join(' · ')));
    const matches = [preview.existing, ...(preview.closedMatches || []), ...(preview.otherGcs || [])].filter(Boolean);
    if (matches.length) {
      const list = element('ul');
      for (const row of matches) {
        list.append(element('li', [row.companyName || row.email, row.name, row.id, row.stage, row.status, row.assignedUserId].filter(Boolean).join(' · ')));
      }
      details.append(list);
    }
    if (preview.error) details.append(element('p', preview.error));
    if (preview.missing_fields?.length) details.append(element('p', 'Enter ' + preview.missing_fields.join(', ') + '.'));
    if (preview.rebidRequired && !args.rebid) details.append(element('p', 'Select the rebid checkbox and preview again to proceed.'));
    if (!preview.canConfirm) return;
    if (preview.totals) details.append(element('p', 'Proposal total ' + preview.totals.total));
    const idempotencyKey = crypto.randomUUID();
    const confirm = Object.assign(element('button', 'Confirm'), { type: 'button', className: 'primary' });
    const cancel = Object.assign(element('button', 'Cancel'), { type: 'button' });
    cancel.onclick = () => details.replaceChildren();
    confirm.onclick = async () => {
      confirm.disabled = cancel.disabled = true;
      for (const field of form.elements) field.disabled = true;
      try {
        const result = await request({ args, dryRun: false, hash: preview.hash, idempotencyKey });
        details.replaceChildren(element('p', result.pending ? 'The Desk accepted the booking. Its opportunity ID is pending.' : 'Created opportunity ' + result.opportunityId));
        if (result.deskUrl) details.append(Object.assign(element('a', 'Open Estimating Desk'), { href: result.deskUrl }));
      } catch (error) {
        if (error.result?.preview) show(error.result.preview, args);
        details.append(element('p', error.message));
        confirm.disabled = cancel.disabled = false;
      } finally {
        for (const field of form.elements) field.disabled = false;
      }
    };
    details.append(confirm, cancel);
  }

  form.onsubmit = async event => {
    event.preventDefault();
    const values = new FormData(form);
    const args = Object.fromEntries(fields.map(([name]) => [name, values.get(name)]));
    args.rebid = values.has('rebid');
    details.replaceChildren(element('p', 'Checking the Desk pipelines…'));
    for (const field of form.elements) field.disabled = true;
    try {
      const { preview } = await request({ args, dryRun: true });
      show(preview, args);
    } catch (error) {
      const missing = error.result?.missing_fields;
      details.replaceChildren(element('p', missing?.length ? 'Enter ' + missing.join(', ') + '.' : error.message));
    } finally {
      for (const field of form.elements) field.disabled = false;
    }
  };
  return panel;
}
