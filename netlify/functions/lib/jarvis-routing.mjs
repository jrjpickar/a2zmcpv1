// Deterministic first pass so most delegations cost no extra Groq call.
const intents = {
  email: /\b(?:e-?mails?|mail|inbox|mailbox|unread|replies|reply to|needs? a reply|awaiting (?:a )?reply|bid invitations?|invoice mail|sender|subject line)\b/i,
  gemini: /\b(?:gemini|second opinion)\b/i,
  cloudflare: /\b(?:cloudflare|workers ai|llama|third opinion)\b/i,
  qc: /\b(?:qc|quality check|review (?:this|the|my) (?:plan|change|proposal)|audit (?:this|the) plan)\b/i,
  build: /\b(?:build|create|develop|add (?:a|an) (?:view|module|card|panel)|module|sql|view|schedule (?:a )?refresh|execution plan|automate)\b/i,
  systems: /\b(?:kpis?|metrics?|runway|cash|burn|pipelines?|wins?|leads|proposals?|crews?|workers?|workforce|labor|containers?|twilio|make credits|netlify|deploys?|feeds?|sources?|diagnostics?|health|coverage)\b/i,
};
export function routeIntent(prompt, bots = []) {
  if (/\b(?:draft|compose|write|search|find|read)\b[^.!?]{0,60}\b(?:e-?mail|inbox|mailbox|thread|reply|sender|subject)\b/i.test(prompt)) return 'email';
  const hits = Object.entries(intents)
    .filter(([id, pattern]) => pattern.test(id === 'systems' ? prompt.replace(/\bworkers ai\b/gi, '') : prompt))
    .map(([id]) => id);
  for (const bot of bots) {
    const name = bot.name.toLowerCase();
    if (name.length >= 3 && prompt.toLowerCase().includes(name)) hits.push(bot.id);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length === 2 && hits.includes('build') && hits.includes('systems')) return 'build';
  return null;
}
