import { openJarvisStore } from './lib/jarvis-store.mjs';
import { mailSettings, syncMailbox } from './lib/jarvis-mail.mjs';

// Every 30 minutes: refresh the Email agent's mailbox snapshot. No Groq calls.
// Skips when either mailbox token is missing or JARVIS_EMAIL_SYNC=off.
export default async () => {
  try {
    if (!mailSettings().enabled) return console.log('JARVIS mail sync skipped');
    const snapshot = await syncMailbox({ store: await openJarvisStore() });
    console.log('JARVIS mail sync', JSON.stringify({ messages: snapshot.messages.length, messagesAvailable: snapshot.messagesAvailable }));
  } catch (error) {
    console.log('JARVIS mail sync failed', error.message);
  }
};
export const config = { schedule: '*/30 * * * *' };
