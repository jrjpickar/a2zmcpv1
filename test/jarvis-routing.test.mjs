import test from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../netlify/functions/lib/jarvis-routing.mjs';

const scenarios = {
  email: ['Draft an email to the GC', 'Read the inbox thread', 'Find mail from our estimator', 'Any unread emails?', 'Search by sender'],
  systems: ['Show the KPIs', 'How much runway do we have?', 'Show Twilio status', 'Show diagnostics', 'How many leads arrived?'],
  build: ['Build a view of wins by pipeline', 'Create a SQL view', 'Add a card', 'Schedule a refresh', 'Develop an execution plan'],
  qc: ['Review this plan', 'Audit the plan', 'Run QC', 'Quality check this', 'Review my change'],
  gemini: ['Ask Gemini', 'Get a second opinion', 'Use Gemini to rewrite this', 'I want a second opinion', 'Try Gemini here'],
  cloudflare: ['Use Workers AI', 'Give me a third opinion', 'Try Cloudflare', 'Rewrite this with Llama', 'Ask Workers AI'],
  'bot-materials': ['Ask Materials', 'Use Materials', 'Try Materials', 'Hand this to Materials', 'Send this to Materials'],
  fallback: ['Hello', 'What can you do?', 'Help me decide', 'Explain this', 'Can you help?'],
};
const bots = [{ id: 'bot-materials', name: 'Materials' }];

for (const [role, prompts] of Object.entries(scenarios)) {
  for (const prompt of prompts) {
    test('Dispatcher: ' + prompt, () => assert.equal(routeIntent(prompt, bots), role === 'fallback' ? null : role));
  }
}
