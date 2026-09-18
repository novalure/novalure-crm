import type { Pool as LocalPool } from "pg";

let pool: LocalPool | undefined;
let target: string | undefined;

/** Explicit loopback-only development transport. Never reads provider credentials or disables auth. */
export function localTestDatabaseTarget(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CRM_LOCAL_TEST_DATABASE !== "1") return null;
  if (!["development", "test"].includes(env.NODE_ENV ?? "") || env.VERCEL !== undefined || env.VERCEL_ENV !== undefined || env.VERCEL_URL !== undefined) {
    throw new Error("Local test database transport is forbidden outside local development/test");
  }
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("Local test database URL is invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.search || parsed.hash || !parsed.username || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("Local test database transport requires an explicit loopback PostgreSQL URL without options");
  }
  return parsed.toString();
}

export async function getLocalTestPool(databaseUrl: string): Promise<LocalPool | null> {
  const resolved = localTestDatabaseTarget(databaseUrl);
  if (!resolved) return null;
  if (target && target !== resolved) throw new Error("Local test database target changed after pool initialization");
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: resolved, max: 8, idleTimeoutMillis: 10_000, allowExitOnIdle: true, ssl: false });
    target = resolved;
  }
  return pool;
}

export async function closeLocalTestPool() {
  const active = pool;
  pool = undefined;
  target = undefined;
  if (active) await active.end();
}
