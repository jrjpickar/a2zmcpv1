const rules = [
  ['Email', /\b(?:e-?mails?|inbox|mailbox|sender|reply|newsletter)\b/i],
  ['Estimating', /\b(?:estimat\w*|bids?|takeoff|pricing|proposal)\b/i],
  ['Scheduling', /\b(?:schedul\w*|calendar|deadline|dispatch|shift)\b/i],
  ['Hiring', /\b(?:hiring|recruit\w*|applicants?|interviews?|onboarding)\b/i],
  ['QC', /\b(?:qc|quality control|inspection|audit|defect)\b/i],
  ['Development', /\b(?:develop\w*|code|sql|module|software|bug|build)\b/i],
  ['Systems', /\b(?:systems?|kpis?|metrics?|runway|health|pipeline)\b/i],
  ['Field Ops', /\b(?:field|crew|workforce|jobsite|demolition|foreman|equipment)\b/i],
];

export const starterTopics = rules.map(([name]) => name);

export function topicFor(text) {
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'General';
}
