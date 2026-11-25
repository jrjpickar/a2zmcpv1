// Netlify build step: writes public/version.json with the commit being deployed. The VM's a2z-auto-update timer (11 AM and 3 PM Pacific) reads it
// from the live site to follow the published deploy (rollbacks included) without a Netlify token. No-op outside Netlify.
import { writeFileSync } from 'node:fs';

const commit = process.env.COMMIT_REF || '';
if (/^[0-9a-f]{40}$/.test(commit)) {
  writeFileSync(new URL('../public/version.json', import.meta.url), JSON.stringify({ commit, deployId: process.env.DEPLOY_ID || '', context: process.env.CONTEXT || '' }) + '\n');
  console.log('version.json written for ' + commit.slice(0, 7));
}
