import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const ports = new Set((process.env.PROPERTY_REACHABILITY_HTTP_PORTS ?? '').split(',').map(Number));
if (ports.size !== 2 || [...ports].some(p => !Number.isSafeInteger(p) || p < 1 || p > 65535)) throw new Error('LOCAL_HTTP_EXACT_PORTS_REQUIRED');
const state = { blocked: 0 };
globalThis[Symbol.for('property-reachability-http-network')] = state;
const loopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
function deny() { state.blocked++; throw new Error('LOCAL_HTTP_EXTERNAL_NETWORK_DENIED'); }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args, first = values[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: typeof values[1] === 'string' ? values[1] : 'localhost' };
  if (options.path || !loopback(options.host ?? options.hostname ?? 'localhost') || !ports.has(Number(options.port))) deny();
  return originalConnect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) { if (!loopback(host)) deny(); return lookup.call(this, host, ...args); };
const asyncLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) { if (!loopback(host)) deny(); return asyncLookup.call(this, host, ...args); };
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const value = new URL(input instanceof Request ? input.url : input);
  if (!['http:', 'https:'].includes(value.protocol) || !loopback(value.hostname) || !ports.has(Number(value.port || (value.protocol === 'https:' ? 443 : 80)))) deny();
  return fetch(input, { ...init, redirect: 'error' });
};
syncBuiltinESMExports();
