// Loopback-only development server for the routes needed by the voice demo.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ask from '../netlify/functions/ask.mjs';
import voice from '../netlify/functions/voice.mjs';
import slack from '../netlify/functions/slack-voice.mjs';
import metrics from '../netlify/functions/metrics.mjs';
import alerts from '../netlify/functions/alerts.mjs';
import diagnostics from '../netlify/functions/diagnostics.mjs';
import highlevel from '../netlify/functions/highlevel-session.mjs';
import mail from '../netlify/functions/mail.mjs';
import mailSummary from '../netlify/functions/mail-summary.mjs';
import mcp from '../netlify/functions/mcp.mjs';

const root = fileURLToPath(new URL('../public', import.meta.url));
const handlers = {
  '/api/ask': ask, '/api/voice': voice, '/api/slack/voice': slack, '/api/metrics': metrics,
  '/api/alerts': alerts, '/api/diagnostics': diagnostics, '/api/highlevel/session': highlevel,
  '/api/mail': mail, '/api/mail-summary': mailSummary, '/mcp': mcp,
};
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; style-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
};

const port = Number(process.env.PORT || 8888);
const host = '127.0.0.1';
const base = 'http://' + host + ':' + port;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== host + ':' + port) return res.writeHead(403).end();
    const url = new URL(req.url, base);
    if (Object.hasOwn(handlers, url.pathname)) {
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const request = new Request(url, {
        method: req.method, headers: req.headers, signal: abort.signal,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      });
      const response = await handlers[url.pathname](request);
      if (res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
      return;
    }
    if (req.method !== 'GET') return res.writeHead(405).end();
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    const type = mime[extname(path)];
    if (!path.startsWith(root + sep) || !type) return res.writeHead(404).end();
    const file = await readFile(path).catch(() => null);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { ...headers, 'Content-Type': type + '; charset=utf-8' }).end(file);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(port, host, () => console.log('A2Z voice development server at ' + base));
