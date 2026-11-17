import { runCheck } from './lib/alerts.mjs';

// Every 15 minutes. Exits before any source read when alerts are off or no rule is enabled.
export default async () => {
  console.log('Alert check', JSON.stringify(await runCheck()));
};
export const config = { schedule: '*/15 * * * *' };
