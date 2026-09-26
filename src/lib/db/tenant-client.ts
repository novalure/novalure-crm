import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "@neondatabase/serverless";
import { getLocalTestPool } from "./local-test-transport";

export type TenantScope = Readonly<{
  actorId: string;
  workspaceId: string;
}>;

export type TenantTransaction = Readonly<{
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

export type TenantPool = Readonly<{
  connect(): Promise<PoolClient>;
}>;

export type TenantTransactionOptions = Readonly<{
  /** A transaction-capable pool override for isolated tests. */
  pool?: TenantPool;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const transactionControlPattern =
  /^\s*(?:begin|commit|discard|end|prepare\s+transaction|release|reset|rollback|savepoint|set|start\s+transaction)\b/i;
const contextMutationPattern = /\bset_config\s*\(/i;

let tenantPool: Pool | null = null;
let tenantPoolDatabaseUrl = "";

function cleanDatabaseUrl(value: string | undefined) {
  if (!value) return "";

  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  const prefixedUrl = trimmed.match(/^[A-Z0-9_]+=((?:postgres|postgresql):\/\/.+)$/i);

  return prefixedUrl?.[1] ?? trimmed;
}

export function resolveTenantDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const generic = (
    cleanDatabaseUrl(env.DATABASE_URL) ||
    cleanDatabaseUrl(env.POSTGRES_URL) ||
    cleanDatabaseUrl(env.POSTGRES_DATABASE_URL) ||
    cleanDatabaseUrl(env.POSTGRES_PRISMA_URL)
  );
  const evm08bPreview = env.VERCEL === "1" && env.VERCEL_ENV === "preview"
    && env.VERCEL_GIT_COMMIT_REF === "codex/evm-08b1-read-contracts";
  if (!evm08bPreview) return generic;
  const isolatedQa = cleanDatabaseUrl(env.G27_QA_DATABASE_URL);
  if (!isolatedQa) throw new Error("EVM-08B.1 Preview QA database is not configured");
  if (generic && generic !== isolatedQa) throw new Error("EVM-08B.1 Preview database target conflict");
  return isolatedQa;
}

async function getTenantPool(): Promise<TenantPool> {
  const databaseUrl = resolveTenantDatabaseUrl();
  const local = await getLocalTestPool(databaseUrl);
  if (local) return local as unknown as TenantPool;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured for tenant transactions");
  }

  if (tenantPool && tenantPoolDatabaseUrl !== databaseUrl) {
    throw new Error("Tenant database target changed after pool initialization");
  }

  if (!tenantPool) {
    tenantPool = new Pool({
      allowExitOnIdle: true,
      connectionString: databaseUrl,
      idleTimeoutMillis: 10_000,
      max: 5,
    });
    tenantPoolDatabaseUrl = databaseUrl;
  }

  return tenantPool;
}

function assertTenantScope(scope: TenantScope) {
  if (!uuidPattern.test(scope.workspaceId)) {
    throw new Error("A valid workspaceId is required for tenant queries");
  }
  if (!uuidPattern.test(scope.actorId)) {
    throw new Error("A valid actorId is required for tenant queries");
  }
}

function assertTenantStatement(query: string) {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Tenant query must not be empty");
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("Tenant queries must contain exactly one SQL statement");
  }
  const withoutLeadingComments = withoutTrailingSemicolon
    .replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/, "")
    .trimStart();
  if (
    transactionControlPattern.test(withoutLeadingComments) ||
    contextMutationPattern.test(withoutLeadingComments)
  ) {
    throw new Error("Tenant queries cannot change transaction or tenant context");
  }
}

async function setAndVerifyTenantContext(client: PoolClient, scope: TenantScope) {
  const result = await client.query<{ actorId: string; workspaceId: string }>(
    `
      select
        set_config('app.tenant_id', $1, true) as "workspaceId",
        set_config('app.actor_id', $2, true) as "actorId"
    `,
    [scope.workspaceId, scope.actorId],
  );
  const context = result.rows[0];

  if (context?.workspaceId !== scope.workspaceId || context.actorId !== scope.actorId) {
    throw new Error("Tenant transaction context could not be verified");
  }
}

async function assertSafeTenantDatabaseRole(client: PoolClient) {
  const checked = await client.query<{ safe: boolean }>(`
    select (
      not runtime_role.rolsuper and not runtime_role.rolbypassrls
      and not runtime_role.rolcreatedb and not runtime_role.rolcreaterole and not runtime_role.rolreplication
      and pg_has_role(runtime_role.oid, 'novalure_tenant_app', 'USAGE')
      and not exists (
        select 1 from pg_class relation join pg_namespace schema on schema.oid=relation.relnamespace
        where schema.nspname='public' and relation.relrowsecurity and relation.relkind in ('r','p')
          and (relation.relowner=runtime_role.oid or pg_has_role(runtime_role.oid,relation.relowner,'MEMBER'))
      )
    ) as safe from pg_roles runtime_role where runtime_role.rolname=current_user
  `);
  if (checked.rows[0]?.safe !== true) throw new Error("Tenant database role is unsafe: a non-owner, non-privileged tenant runtime role is required");
}

/**
 * Runs every callback query on one checked-out connection and one transaction.
 * PostgreSQL transaction-local settings are cleared by COMMIT/ROLLBACK before
 * that connection is returned to the pool.
 */
export async function withTenantTransaction<Result>(
  scope: TenantScope,
  callback: (transaction: TenantTransaction) => Promise<Result>,
  options: TenantTransactionOptions = {},
) {
  assertTenantScope(scope);
  const pool = options.pool ?? await getTenantPool();
  const client = await pool.connect();
  let active = false;
  let released = false;
  let queryFailure: unknown;
  let pendingQuery: Promise<unknown> = Promise.resolve();

  const runQuery = async <Row extends QueryResultRow>(
    query: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> => {
    if (!active) throw new Error("Tenant transaction is no longer active");
    assertTenantStatement(query);
    const scheduled = pendingQuery.then(async () => {
      if (!active) throw new Error("Tenant transaction is no longer active");
      if (queryFailure) throw queryFailure;
      return client.query<Row>(query, [...params]);
    });
    pendingQuery = scheduled.catch(() => undefined);
    try {
      return await scheduled;
    } catch (error) {
      queryFailure ??= error;
      throw error;
    }
  };

  const transaction: TenantTransaction = Object.freeze({
    async execute(query: string, params: readonly unknown[] = []) {
      await runQuery(query, params);
    },
    async query<Row extends QueryResultRow = QueryResultRow>(
      query: string,
      params: readonly unknown[] = [],
    ) {
      return (await runQuery<Row>(query, params)).rows;
    },
    async queryOne<Row extends QueryResultRow = QueryResultRow>(
      query: string,
      params: readonly unknown[] = [],
    ): Promise<Row | null> {
      return (await runQuery<Row>(query, params)).rows[0] ?? null;
    },
  });

  try {
    await assertSafeTenantDatabaseRole(client);
    await client.query("begin");
    await setAndVerifyTenantContext(client, scope);
    active = true;
    const result = await callback(transaction);
    // Repositories may catch SQL failures. PostgreSQL then treats COMMIT as
    // ROLLBACK; never return a successful business result from an aborted tx.
    if (queryFailure) throw queryFailure;
    active = false;
    const committed = await client.query("commit");
    if (committed.command && committed.command !== "COMMIT") throw new Error("Tenant transaction did not commit");
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

export async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  scope: TenantScope,
  query: string,
  params: readonly unknown[] = [],
  options: TenantTransactionOptions = {},
) {
  return withTenantTransaction(
    scope,
    (transaction) => transaction.query<Row>(query, params),
    options,
  );
}

/** Isolated authentication bootstrap; the same runtime-role checks apply before any SQL. */
export async function queryAuthenticationRows<Row extends QueryResultRow = QueryResultRow>(
  query: string, params: readonly unknown[] = [], options: TenantTransactionOptions = {},
): Promise<Row[]> {
  assertTenantStatement(query);
  const pool = options.pool ?? await getTenantPool();
  const client = await pool.connect();
  let begun = false;
  let discarded = false;
  try {
    await assertSafeTenantDatabaseRole(client);
    await client.query("begin"); begun = true;
    await client.query("select set_config('app.tenant_id','',true),set_config('app.actor_id','',true)");
    const rows = (await client.query<Row>(query, [...params])).rows;
    await client.query("commit"); begun = false;
    return rows;
  } catch (error) {
    if (begun) { try { await client.query("rollback"); } catch { client.release(true); discarded = true; begun = false; throw error; } }
    throw error;
  } finally { if (!discarded) client.release(); }
}
