// Weekdays 7:05 AM Pacific (15:05 UTC, standard time): post the Systems briefing to SLACK_BRIEFING_CHANNEL.
// Skips when SLACK_BOT_TOKEN or SLACK_BRIEFING_CHANNEL is missing.
import { postBriefing } from './lib/slack.mjs';

export default async () => {
  try {
    const result = await postBriefing();
    console.log('Slack briefing', JSON.stringify(result));
  } catch (error) {
    console.log('Slack briefing failed', error.message);
  }
};
export const config = { schedule: '5 15 * * 1-5' };
