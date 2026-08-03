import { neon, Pool, type PoolClient } from "@neondatabase/serverless";
import { databaseEnv } from "@/lib/db/schema";

type SqlClient = ReturnType<typeof neon>;

let sqlClient: SqlClient | null = null;
let pool: Pool | null = null;

export type QueryExecutor = {
  queryRows<Row extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  queryOne<Row extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row | null>;
};

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

function getPool() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) throw new Error(`${databaseEnv.pooledUrl} is not configured`);
  if (!pool) pool = new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}

function createPoolExecutor(client: PoolClient): QueryExecutor {
  return {
    async queryRows<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const result = await client.query(query, params);
      return result.rows as Row[];
    },
    async queryOne<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const result = await client.query(query, params);
      return (result.rows[0] as Row | undefined) ?? null;
    },
  };
}

export async function withTransaction<Result>(
  callback: (executor: QueryExecutor) => Promise<Result>,
): Promise<Result> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await callback(createPoolExecutor(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryRows<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
  const rows = await getSqlClient().query(query, params);
  return rows as Row[];
}

export async function queryOne<Row extends Record<string, unknown>>(query: string, params: unknown[] = []) {
  const rows = await queryRows<Row>(query, params);
  return rows[0] ?? null;
}

export async function executeQuery(query: string, params: unknown[] = []) {
  await getSqlClient().query(query, params);
}
