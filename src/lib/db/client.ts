import { neon } from "@neondatabase/serverless";
import { databaseEnv } from "@/lib/db/schema";
import { withDatabaseConnectionRetry } from "@/lib/db/connection-retry";

type SqlClient = ReturnType<typeof neon>;

let sqlClient: SqlClient | null = null;

export function hasDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
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
  await withDatabaseConnectionRetry(
    () => getSqlClient().query(query, params),
    {
      onRetry: ({ attempt, delayMs, reason }) => {
        console.warn(JSON.stringify({ attempt, delayMs, event: "database_connection_retry", reason }));
      },
    },
  );
}
