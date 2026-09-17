import { neon } from "@neondatabase/serverless";
import { databaseEnv } from "@/lib/db/schema";
import { withDatabaseConnectionRetry } from "@/lib/db/connection-retry";
import { currentTenantTransaction } from "@/lib/db/transaction-context";
import { getLocalTestPool } from "@/lib/db/local-test-transport";

type SqlClient = ReturnType<typeof neon>;

let sqlClient: SqlClient | null = null;

export function hasDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  if (currentTenantTransaction()) return true;
  return Boolean(resolveDatabaseUrl(env));
}

function cleanDatabaseUrl(value: string | undefined) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  return (
    cleanDatabaseUrl(env[databaseEnv.pooledUrl]) ||
    cleanDatabaseUrl(env.POSTGRES_URL) ||
    cleanDatabaseUrl(env.POSTGRES_DATABASE_URL) ||
    cleanDatabaseUrl(env.POSTGRES_PRISMA_URL)
  );
}

export function getSqlClient() {
  const databaseUrl = resolveDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(`${databaseEnv.pooledUrl} is not configured`);
  }

  if (!sqlClient) {
    sqlClient = neon(databaseUrl);
  }

  return sqlClient;
}

export async function queryRows<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
  const active = currentTenantTransaction();
  if (active) return active.transaction.query<Row>(query, params);
  const local = await getLocalTestPool(resolveDatabaseUrl());
  if (local) return (await local.query<Row>(query, params)).rows;
  const rows = await withDatabaseConnectionRetry(
    () => getSqlClient().query(query, params),
    {
      onRetry: ({ attempt, delayMs, reason }) => {
        console.warn(JSON.stringify({ attempt, delayMs, event: "database_connection_retry", reason }));
      },
    },
  );
  return rows as Row[];
}

export async function queryOne<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
  const rows = await queryRows<Row>(query, params);
  return rows[0] ?? null;
}

export async function executeQuery(query: string, params: unknown[] = []) {
  const active = currentTenantTransaction();
  if (active) return active.transaction.execute(query, params);
  const local = await getLocalTestPool(resolveDatabaseUrl());
  if (local) { await local.query(query, params); return; }
  await withDatabaseConnectionRetry(
    () => getSqlClient().query(query, params),
    {
      onRetry: ({ attempt, delayMs, reason }) => {
        console.warn(JSON.stringify({ attempt, delayMs, event: "database_connection_retry", reason }));
      },
    },
  );
}
