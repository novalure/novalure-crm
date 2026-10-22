import { createRequire } from "node:module";
import { getCACertificates } from "node:tls";
import pg from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { assertDatabaseTarget } from "./infra-targets.mjs";

const require = createRequire(import.meta.url);

export function resolveMigrationTransport(env = process.env) {
  const transport = env.MIGRATION_TRANSPORT?.trim() || "pg";
  if (!["pg", "neon-websocket"].includes(transport)) {
    throw new Error("MIGRATION_TRANSPORT must be pg or neon-websocket.");
  }
  return transport;
}

/** Explicit HTTPS-sidecar transport; importing this module opens no connection. */
export function configureMigrationNeonTransport(env = process.env, dependencies = {}) {
  const proxy = env.HTTPS_PROXY;
  try {
    const url = new URL(proxy);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error("The neon-websocket migration transport requires a valid HTTPS_PROXY.");
  }
  const WebSocket = dependencies.WebSocket ?? require("next/dist/compiled/ws");
  const HttpsProxyAgent = dependencies.HttpsProxyAgent ?? require("next/dist/compiled/https-proxy-agent").HttpsProxyAgent;
  const certificates = dependencies.getCACertificates ?? getCACertificates;
  const config = dependencies.neonConfig ?? neonConfig;
  const ca = [...certificates("default"), ...certificates("system")];
  const agent = new HttpsProxyAgent(proxy);
  config.useSecureWebSocket = true;
  config.webSocketConstructor = class MigrationProxyWebSocket extends WebSocket {
    constructor(address, protocols, options) {
      super(address, protocols, { ...options, agent, ca, rejectUnauthorized: true });
    }
  };
}

/** Host/project guards run before either driver can construct a pool. */
export function createMigrationPool({ databaseUrl, target, options = {}, env = process.env }, dependencies = {}) {
  assertDatabaseTarget({ connectionMode: "direct", databaseUrl, env, purpose: "schema migration", target });
  const transport = resolveMigrationTransport(env);
  if (transport === "neon-websocket") {
    (dependencies.configureNeonTransport ?? configureMigrationNeonTransport)(env);
  }
  const Pool = transport === "pg" ? dependencies.NativePool ?? pg.Pool : dependencies.NeonPool ?? NeonPool;
  return new Pool({ ...options, connectionString: databaseUrl });
}
