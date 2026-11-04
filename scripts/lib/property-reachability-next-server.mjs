import { createServer } from 'node:http';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

const directory = process.env.PROPERTY_REACHABILITY_NEXT_DIRECTORY;
const nonce = process.env.PROPERTY_REACHABILITY_HTTP_NONCE;
const port = Number(process.env.PORT);
if (!directory || !path.isAbsolute(directory) || !nonce || !Number.isInteger(port)) throw new Error('LOCAL_NEXT_BINDING_REQUIRED');
if ((await readdir(directory)).some(name => /^\.env(?:\.|$)/.test(name))) throw new Error('LOCAL_NEXT_ENV_FILE_PRESENT_REFUSE_READ');
let app, server, stopping;
const send = value => { if (process.connected) process.send({ nonce, ...value }); };
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (server) { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    if (app) await app.close();
    send({ type: 'STOPPED', blockedNetworkAttempts: globalThis[Symbol.for('property-reachability-http-network')]?.blocked ?? null });
    process.exit(0);
  })();
  return stopping;
}
process.on('message', message => { if (message?.nonce === nonce && message.type === 'STOP') void stop().catch(() => { send({ type: 'ERROR', code: 'LOCAL_NEXT_CLOSE_FAILED' }); }); });
process.on('disconnect', () => { void stop().catch(() => undefined); });
try {
  const { default: next } = await import('next');
  app = next({ dev: true, dir: directory, hostname: '127.0.0.1', port, webpack: true });
  await app.prepare();
  const handle = app.getRequestHandler();
  server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(503); response.end('LOCAL_NEXT_HANDLER_FAILURE'); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  send({ type: 'READY', origin: `http://127.0.0.1:${port}` });
} catch { send({ type: 'ERROR', code: 'LOCAL_NEXT_PREPARE_FAILED' }); }
