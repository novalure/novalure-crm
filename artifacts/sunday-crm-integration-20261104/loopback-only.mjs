import net from 'node:net';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = first && typeof first === 'object' ? first : {};
  const host = options.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (options.path === undefined && !['localhost', '127.0.0.1', '::1'].includes(host)) throw Error('LOCAL_QA_EXTERNAL_SOCKET_DENIED');
  return Reflect.apply(connect, this, args);
};
