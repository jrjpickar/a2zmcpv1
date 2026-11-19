import { WebSocket } from 'ws';
import { createSlackWorker, slackApi } from '../netlify/functions/lib/slack.mjs';

export function startSlackSocket({ env, openStore, jarvis, memory, execute }) {
  const token = env.SLACK_APP_TOKEN?.trim();
  if (!token) return () => {};
  const worker = createSlackWorker({ env, openStore, jarvis, memory, execute });
  const seen = new Set();
  let stopped = false, socket, reconnect, heartbeat, working = 0, delay = 1000;

  function retry() {
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => { reconnect = null; void connect(); }, delay);
    delay = Math.min(60000, delay * 2);
  }

  async function connect() {
    try {
      const { url } = await slackApi(token, 'apps.connections.open', {});
      const endpoint = new URL(url);
      if (endpoint.protocol !== 'wss:' || !endpoint.hostname.endsWith('.slack.com')) throw new Error('Invalid Slack endpoint');
      if (stopped) return;
      const current = socket = new WebSocket(endpoint, { handshakeTimeout: 10000, maxPayload: 256 * 1024 });
      function resetHeartbeat() {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => current.terminate(), 90000);
      }
      current.on('open', resetHeartbeat);
      current.on('ping', resetHeartbeat);
      current.on('message', raw => {
        resetHeartbeat();
        let envelope;
        try { envelope = JSON.parse(raw.toString()); } catch { return; }
        if (envelope.type === 'hello') { delay = 1000; return; }
        if (envelope.type === 'disconnect') { current.close(); return; }
        if (typeof envelope.envelope_id !== 'string') return;
        const eventId = envelope.payload?.event_id;
        const event = envelope.payload?.event;
        if (envelope.type !== 'events_api' || !event || seen.has(eventId)) {
          current.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          return;
        }
        if (working >= 4) return; // Leave work unacknowledged so Slack can retry.
        current.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (eventId) {
          seen.add(eventId);
          if (seen.size > 500) seen.delete(seen.values().next().value);
        }
        working++;
        void worker(event).catch(() => console.error('Slack event processing failed.')).finally(() => { working--; });
      });
      current.on('error', () => current.terminate());
      current.on('close', () => {
        clearTimeout(heartbeat);
        if (socket === current) socket = null;
        retry();
      });
    } catch {
      console.error('Slack Socket Mode connection failed.');
      retry();
    }
  }

  void connect();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    clearTimeout(heartbeat);
    socket?.terminate();
  };
}
