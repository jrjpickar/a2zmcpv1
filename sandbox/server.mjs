// Local sandbox: sample data only. JARVIS calls Groq only when GROQ_API_KEY is set
// (or use the fixture preload: node --import ./sandbox/fake-groq.mjs sandbox/server.mjs).
// npm run sandbox  ->  http://127.0.0.1:4174   Dashboard key: A2Z_SANDBOX_KEY or a2z-local-sandbox-key
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localKeyedStore } from './jarvis-store.mjs';

process.env.DATA_MODE = 'sample';
process.env.DASHBOARD_KEY = process.env.A2Z_SANDBOX_KEY || 'a2z-local-sandbox-key';
const { createJarvisHandler } = await import('../netlify/functions/jarvis.mjs');
const { createJarvisMemoryHandler } = await import('../netlify/functions/jarvis-memory.mjs');
const { createExecuteHandler } = await import('../netlify/functions/jarvis-execute.mjs');
const { createInstructionsHandler } = await import('../netlify/functions/jarvis-instructions.mjs');
const store = localKeyedStore(resolve(process.env.A2Z_JARVIS_LOCAL_DIR || '.a2z-jarvis-local'));
const openStore = async () => store;
const limits = { '/api/jarvis': 16384, '/api/jarvis-memory': 8192, '/api/jarvis-execute': 16384 };
const routes = {
  '/api/jarvis': createJarvisHandler({ openStore }),
  '/api/jarvis-memory': createJarvisMemoryHandler({ openStore }),
  '/api/jarvis-execute': createExecuteHandler({ openStore }),
  '/api/jarvis-instructions': createInstructionsHandler({ openStore }),
};
for (const name of ['metrics', 'mail', 'mail-summary', 'mail-filters', 'ask', 'alerts', 'diagnostics']) {
  routes['/api/' + name] = (await import('../netlify/functions/' + name + '.mjs')).default;
}
const types = { html: 'text/html; charset=utf-8', js: 'application/javascript', mjs: 'application/javascript', css: 'text/css' };
const files = new Set(['index.html', 'app.js', 'map.js', 'city3d.js', 'styles.css', 'jarvis.mjs', 'jarvis-topics.mjs', 'topic-rules.mjs', 'animation-frame.mjs', 'instructions.mjs', 'voice.js', 'voice-vad.js', 'voice.css', 'voice-launch.js', 'voice.html']);
const port = Number(process.env.PORT || 4174);
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    const fn = routes[url.pathname];
    if (fn) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (limits[url.pathname] || 65536)) { res.writeHead(413); res.end('Request body exceeds the size limit.'); return; }
        chunks.push(chunk);
      }
      const response = await fn(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { openStore });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!files.has(name)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': types[name.split('.').pop()], 'cache-control': 'no-store' });
    res.end(await readFile(new URL('../public/' + name, import.meta.url)));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('Sandbox error');
  }
}).listen(port, '127.0.0.1', () => console.log('A2Z MCP sandbox (SAMPLE DATA): http://127.0.0.1:' + port + '  key: ' + process.env.DASHBOARD_KEY));
