import {
  neon,
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "@neondatabase/serverless";
import { databaseEnv } from "@/lib/db/schema";
import { withDatabaseConnectionRetry } from "@/lib/db/connection-retry";

type SqlClient = ReturnType<typeof neon>;

export type DatabaseTransaction = Readonly<{
  execute(query: string, params?: readonly unknown[]): Promise<void>;
  query<Row extends QueryResultRow = QueryResultRow>(
    query: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
  queryOne<Row extends QueryResultRow = QueryResultRow>(
    query: string,
    params?: readonly unknown[],
  ): Promise<Row | null>;
}>;

export type DatabaseTransactionPool = Readonly<{
  connect(): Promise<PoolClient>;
}>;

export type DatabaseTransactionOptions = Readonly<{
  pool?: DatabaseTransactionPool;
}>;

let sqlClient: SqlClient | null = null;
let transactionPool: Pool | null = null;
let transactionPoolDatabaseUrl = "";

const transactionControlPattern =
  /^\s*(?:begin|commit|discard|end|prepare\s+transaction|release|reset|rollback|savepoint|set|start\s+transaction)\b/iu;

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

function getTransactionPool() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    throw new Error(`${databaseEnv.pooledUrl} is not configured`);
  }
  if (transactionPool && transactionPoolDatabaseUrl !== databaseUrl) {
    throw new Error("Database transaction target changed after pool initialization");
  }
  if (!transactionPool) {
    transactionPool = new Pool({
      allowExitOnIdle: true,
      connectionString: databaseUrl,
      idleTimeoutMillis: 10_000,
      max: 5,
    });
    transactionPoolDatabaseUrl = databaseUrl;
  }
  return transactionPool;
}

function assertTransactionStatement(query: string) {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Database transaction query must not be empty");
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/u, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("Database transaction queries must contain exactly one SQL statement");
  }
  const withoutLeadingComments = withoutTrailingSemicolon
    .replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/u, "")
    .trimStart();
  if (transactionControlPattern.test(withoutLeadingComments)) {
    throw new Error("Database transaction callbacks cannot control their transaction");
  }
}

/**
 * Runs a callback on one checked-out connection and one READ COMMITTED
 * transaction. Separate callback queries therefore receive fresh PostgreSQL
 * snapshots while retaining transaction-scoped advisory locks.
 */
export async function withDatabaseTransaction<Result>(
  callback: (transaction: DatabaseTransaction) => Promise<Result>,
  options: DatabaseTransactionOptions = {},
) {
  const pool = options.pool ?? getTransactionPool();
  const client = await pool.connect();
  let active = false;
  let released = false;

  const runQuery = async <Row extends QueryResultRow>(
    query: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> => {
    if (!active) throw new Error("Database transaction is no longer active");
    assertTransactionStatement(query);
    return client.query<Row>(query, [...params]);
  };

  const transaction: DatabaseTransaction = {
    async execute(query: string, params: readonly unknown[] = []): Promise<void> {
      await runQuery(query, params);
    },
    async query<Row extends QueryResultRow = QueryResultRow>(
      query: string,
      params: readonly unknown[] = [],
    ): Promise<Row[]> {
      return (await runQuery<Row>(query, params)).rows;
    },
    async queryOne<Row extends QueryResultRow = QueryResultRow>(
      query: string,
      params: readonly unknown[] = [],
    ): Promise<Row | null> {
      return (await runQuery<Row>(query, params)).rows[0] ?? null;
    },
  };
  Object.freeze(transaction);

  try {
    await client.query("begin");
    active = true;
    const result = await callback(transaction);
    active = false;
    await client.query("commit");
    return result;
  } catch (error) {
    active = false;
    try {
      await client.query("rollback");
    } catch {
      client.release(true);
      released = true;
      throw error;
    }
    throw error;
  } finally {
    if (active) active = false;
    if (!released) client.release();
  }
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
