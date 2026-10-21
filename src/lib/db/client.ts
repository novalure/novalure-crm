import { neon, Pool, type PoolClient } from "@neondatabase/serverless";
import { AsyncLocalStorage } from "node:async_hooks";
import { databaseEnv } from "@/lib/db/schema";
import { withDatabaseConnectionRetry } from "@/lib/db/connection-retry";
import { currentTenantTransaction } from "@/lib/db/transaction-context";
import { getLocalTestPool } from "@/lib/db/local-test-transport";

type SqlClient = ReturnType<typeof neon>;

let sqlClient: SqlClient | null = null;
let publicSubmissionPool: Pool | null = null;
let publicSubmissionPoolUrl = "";
type PublicSubmissionTransaction = { query<Row extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<Row[]> };
const publicSubmissionTransactions = new AsyncLocalStorage<PublicSubmissionTransaction>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PublicSubmissionTransactionError extends Error {
  constructor(readonly rollbackConfirmed: boolean, cause: unknown) {
    super("Public submission transaction failed", { cause });
  }
}

export function hasDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  if (currentTenantTransaction() || publicSubmissionTransactions.getStore()) return true;
  return Boolean(resolveDatabaseUrl(env));
}

export function hasBoundTenantTransaction() {
  return Boolean(currentTenantTransaction() || publicSubmissionTransactions.getStore());
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
  const publicSubmission = publicSubmissionTransactions.getStore();
  if (publicSubmission) return publicSubmission.query<Row>(query, params);
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
  const publicSubmission = publicSubmissionTransactions.getStore();
  if (publicSubmission) { await publicSubmission.query(query, params); return; }
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

/** Uses the same database role as anonymous form ingestion, with one connection for all writes. */
export async function withPublicSubmissionTransaction<Result>(
  scope: { actorId: string; workspaceId: string },
  callback: () => Promise<Result>,
  options: { pool?: { connect(): Promise<PoolClient> }; readOnly?: boolean } = {},
): Promise<Result> {
  if (currentTenantTransaction() || publicSubmissionTransactions.getStore()) {
    throw new Error("Public submission transactions cannot be nested");
  }
  if (!uuidPattern.test(scope.workspaceId) || !uuidPattern.test(scope.actorId)) {
    throw new PublicSubmissionTransactionError(true, new Error("Invalid public submission tenant context"));
  }
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) throw new PublicSubmissionTransactionError(true, new Error("Database URL is not configured"));
  let local;
  try { local = options.pool ? null : await getLocalTestPool(databaseUrl); }
  catch (error) { throw new PublicSubmissionTransactionError(true, error); }
  if (!publicSubmissionPool && !local && !options.pool) {
    publicSubmissionPool = new Pool({ allowExitOnIdle: true, connectionString: databaseUrl, idleTimeoutMillis: 10_000, max: 5 });
    publicSubmissionPoolUrl = databaseUrl;
  }
  if (!local && !options.pool && publicSubmissionPoolUrl !== databaseUrl) {
    throw new PublicSubmissionTransactionError(true, new Error("Public submission database target changed"));
  }
  let client: PoolClient;
  try { client = await (options.pool ?? local ?? publicSubmissionPool!).connect() as PoolClient; }
  catch (error) { throw new PublicSubmissionTransactionError(true, error); }
  let begun = false;
  let commitAttempted = false;
  let discardConnection = false;
  let queryFailure: unknown;
  let pendingQuery: Promise<unknown> = Promise.resolve();
  try {
    await client.query(options.readOnly ? "begin read only" : "begin");
    begun = true;
    const role = await client.query<{ safe: boolean }>(`
      select (
        not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
        and not r.rolcreaterole and not r.rolreplication
        and pg_has_role(r.oid, 'novalure_tenant_app', 'USAGE')
        and not exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relrowsecurity and c.relkind in ('r','p')
            and (c.relowner = r.oid or pg_has_role(r.oid, c.relowner, 'MEMBER'))
        )
      ) as safe from pg_roles r where r.rolname = current_user
    `);
    if (role.rows[0]?.safe !== true) throw new Error("Unsafe public submission database role");
    const context = await client.query<{ actorId: string; workspaceId: string }>(
      `select set_config('app.tenant_id', $1, true) as "workspaceId",
              set_config('app.actor_id', $2, true) as "actorId"`,
      [scope.workspaceId, scope.actorId],
    );
    if (context.rows[0]?.workspaceId !== scope.workspaceId || context.rows[0]?.actorId !== scope.actorId) {
      throw new Error("Public submission tenant context could not be verified");
    }
    const transaction: PublicSubmissionTransaction = {
      async query<Row extends Record<string, unknown>>(sql: string, params: unknown[]) {
        const scheduled = pendingQuery.then(async () => {
          if (queryFailure) throw queryFailure;
          return (await client.query<Row>(sql, params)).rows;
        });
        pendingQuery = scheduled.catch(() => undefined);
        try { return await scheduled; } catch (error) { queryFailure ??= error; throw error; }
      },
    };
    const result = await publicSubmissionTransactions.run(transaction, callback);
    await pendingQuery;
    if (queryFailure) throw queryFailure;
    commitAttempted = true;
    const committed = await client.query("commit");
    if (committed.command && committed.command !== "COMMIT") throw new Error("Public submission transaction did not commit");
    begun = false;
    return result;
  } catch (error) {
    // Promise.all callers may still have queued writes; drain them before ROLLBACK.
    await pendingQuery;
    let rollbackConfirmed = !begun;
    if (begun) {
      try { await client.query("rollback"); rollbackConfirmed = !commitAttempted; }
      catch { rollbackConfirmed = false; discardConnection = true; }
    }
    if (commitAttempted) discardConnection = true;
    throw new PublicSubmissionTransactionError(rollbackConfirmed, error);
  } finally {
    client.release(discardConnection);
  }
}
