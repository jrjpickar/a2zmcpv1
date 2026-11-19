import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMailbox } from '../netlify/functions/lib/mail.mjs';

test('mail filtering uses raw headers and sender rules, and allowlist wins', () => {
  const messages = [
    { subject: 'Updates', from: 'List <marketing@agency.example>', headers: 'List-Unsubscribe: <mailto:list@example.com>' },
    { subject: 'Receipt', from: 'No Reply <noreply@vendor.example>', headers: 'Auto-Submitted: auto-generated' },
    { subject: 'Project update', from: 'client@example.com', headers: 'Auto-Submitted: no' },
    { subject: 'Offer', from: 'blocked@example.com', headers: '' },
  ];
  const result = filterMailbox(messages, { MAIL_SUMMARY_ALLOWLIST: '@vendor.example', MAIL_SUMMARY_BLOCKLIST: 'blocked@example.com, @vendor.example' });
  assert.deepEqual(result.included, messages.slice(1, 3));
  assert.deepEqual(result.filtered.map(message => message.reason), ['Mailing list', 'Blocked sender']);
});

test('the summary model receives only allowed messages and returns a reviewable filtered count', async () => {
  const { summarizePage } = await import('../netlify/functions/lib/mail.mjs');
  let modelCalls = 0;
  const page = await summarizePage({
    token: 'filter-test-token', apiKey: 'filter-test-key', filters: { allowlist: [], blocklist: [] },
    fetchImpl: async (target, options) => {
      const url = new URL(target);
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'keep' }, { id: 'junk' }] });
      if (url.pathname.endsWith('/message')) {
        assert.equal(url.searchParams.get('headers'), '1');
        return url.searchParams.get('id') === 'keep'
          ? Response.json({ subject: 'Site meeting', body: 'Meet at the gate.', from: 'gc@example.com' })
          : Response.json({ subject: 'Newsletter', body: 'Do not pass this text to the model.', headers: 'List-Unsubscribe: <mailto:list@example.com>' });
      }
      modelCalls++;
      const input = JSON.parse(options.body).messages.at(-1).content;
      assert.match(input, /Site meeting/);
      assert.doesNotMatch(input, /Newsletter|Do not pass/);
      return Response.json({ choices: [{ message: { content: 'Confirm the site meeting.' } }] });
    },
  });
  assert.equal(modelCalls, 1);
  assert.equal(page.summarized, 1);
  assert.equal(page.filtered.length, 1);
  assert.equal(page.filtered[0].reason, 'Mailing list');
});
