import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { getBuildMetadata } from "@/lib/build-metadata";
import { queryRows } from "@/lib/db/client";
import { crmTables, getDatabaseStatus } from "@/lib/db/schema";
import { hasProductCapability } from "@/lib/product-model";

type TableStatusRow = {
  exists: boolean;
  tableName: string;
};

type MigrationLedgerRow = {
  appliedAt: string | Date;
  checksum: string | null;
  name: string;
  version: string;
};

type RuntimeIdentityRow = {
  bypassRls: boolean;
  createDatabase: boolean;
  createRole: boolean;
  currentUser: string;
  database: string;
  databaseCreate: boolean;
  databaseOwner: boolean;
  forbiddenCompanyProfilesSelect: boolean;
  neonBranchId: string | null;
  neonProjectId: string | null;
  ownedOrInheritedPublicTables: number;
  readAllData: boolean;
  reachableElevatedRoles: number;
  relevantMemberships: string[];
  replication: boolean;
  requiredRlsTablesProtected: boolean;
  schemaCreate: boolean;
  sessionUser: string;
  sessionBypassRls: boolean;
  sessionCreateDatabase: boolean;
  sessionCreateRole: boolean;
  sessionDatabaseCreate: boolean;
  sessionDatabaseOwner: boolean;
  sessionReadAllData: boolean;
  sessionReplication: boolean;
  sessionSchemaCreate: boolean;
  sessionSuperuser: boolean;
  sessionWriteAllData: boolean;
  superuser: boolean;
  tenantRuntimeMember: boolean;
  writeAllData: boolean;
};

function canViewSystemDiagnostics(session: Awaited<ReturnType<typeof getRequestSession>>) {
  if (!session) return false;
  return session.productRole === "platform_admin" || hasProductCapability(session.productRole, "novalure:internal");
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!canViewSystemDiagnostics(session)) {
    return NextResponse.json(
      { error: "not_found" },
      {
        headers: { "Cache-Control": "private, no-store" },
        status: 404,
      },
    );
  }

  const status = getDatabaseStatus();
  let tableStatus: TableStatusRow[] = [];
  let tableCheckError: string | null = null;
  let migrationLedger: MigrationLedgerRow[] = [];
  let migrationLedgerError: string | null = null;
  let runtimeIdentity: (RuntimeIdentityRow & { bindingMatchesExpectedProject: boolean; leastPrivilege: boolean }) | null = null;
  let runtimeIdentityError: string | null = null;
  const correlationId = randomUUID();

  if (status.configured) {
    const [tableResult, ledgerResult, identityResult] = await Promise.allSettled([
      queryRows<TableStatusRow>(
        `
          select
            expected.table_name as "tableName",
            (t.table_name is not null) as "exists"
          from unnest($1::text[]) as expected(table_name)
          left join information_schema.tables t
            on t.table_schema = 'public'
           and t.table_name = expected.table_name
          order by expected.table_name
        `,
        [[...crmTables]],
      ),
      queryRows<MigrationLedgerRow>(
        `
          select
            version,
            name,
            checksum,
            applied_at as "appliedAt"
          from novalure_schema_migrations
          order by version asc
        `,
      ),
      queryRows<RuntimeIdentityRow>(`
        with required_rls_tables(table_name) as (
          values
            ('projects'),
            ('contacts'),
            ('leads'),
            ('deals'),
            ('audit_logs'),
            ('seller_listings'),
            ('media_assets'),
            ('property_media'),
            ('property_documents'),
            ('property_activity_events')
        )
        select
          current_database() as "database",
          current_user as "currentUser",
          session_user as "sessionUser",
          current_setting('neon.project_id', true) as "neonProjectId",
          current_setting('neon.branch_id', true) as "neonBranchId",
          runtime_role.rolsuper as "superuser",
          runtime_role.rolbypassrls as "bypassRls",
          runtime_role.rolcreatedb as "createDatabase",
          runtime_role.rolcreaterole as "createRole",
          runtime_role.rolreplication as "replication",
          session_role.rolsuper as "sessionSuperuser",
          session_role.rolbypassrls as "sessionBypassRls",
          session_role.rolcreatedb as "sessionCreateDatabase",
          session_role.rolcreaterole as "sessionCreateRole",
          session_role.rolreplication as "sessionReplication",
          (database.datdba = runtime_role.oid) as "databaseOwner",
          (database.datdba = session_role.oid) as "sessionDatabaseOwner",
          has_database_privilege(current_user, current_database(), 'CREATE') as "databaseCreate",
          has_database_privilege(session_user, current_database(), 'CREATE') as "sessionDatabaseCreate",
          has_schema_privilege(current_user, 'public', 'CREATE') as "schemaCreate",
          has_schema_privilege(session_user, 'public', 'CREATE') as "sessionSchemaCreate",
          pg_has_role(current_user, 'pg_read_all_data', 'MEMBER') as "readAllData",
          pg_has_role(session_user, 'pg_read_all_data', 'MEMBER') as "sessionReadAllData",
          pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') as "writeAllData",
          pg_has_role(session_user, 'pg_write_all_data', 'MEMBER') as "sessionWriteAllData",
          exists (
            select 1
            from pg_roles tenant_role
            where tenant_role.rolname = 'novalure_tenant_app'
              and pg_has_role(current_user, tenant_role.oid, 'USAGE')
          ) as "tenantRuntimeMember",
          coalesce((
            select array_agg(role.rolname::text order by role.rolname)
            from pg_roles role
            where role.rolname in ('novalure_app', 'novalure_tenant_app')
              and (
                pg_has_role(session_user, role.oid, 'USAGE')
                or pg_has_role(session_user, role.oid, 'SET')
              )
          ), array[]::text[]) as "relevantMemberships",
          (
            select count(*)::int
            from pg_roles candidate
            where (
              candidate.rolsuper
              or candidate.rolbypassrls
              or candidate.rolcreatedb
              or candidate.rolcreaterole
              or candidate.rolreplication
              or candidate.oid = database.datdba
              or candidate.rolname in ('pg_read_all_data', 'pg_write_all_data')
            )
            and (
              candidate.oid in (runtime_role.oid, session_role.oid)
              or pg_has_role(session_role.oid, candidate.oid, 'USAGE')
              or pg_has_role(session_role.oid, candidate.oid, 'SET')
            )
          ) as "reachableElevatedRoles",
          (
            select count(*)::int
            from pg_class relation
            join pg_namespace schema on schema.oid = relation.relnamespace
            where schema.nspname = 'public'
              and relation.relkind in ('r', 'p')
              and (
                relation.relowner in (runtime_role.oid, session_role.oid)
                or pg_has_role(session_role.oid, relation.relowner, 'USAGE')
                or pg_has_role(session_role.oid, relation.relowner, 'SET')
              )
          ) as "ownedOrInheritedPublicTables",
          case
            when to_regclass('public.company_profiles') is null then false
            else has_table_privilege(current_user, 'public.company_profiles', 'SELECT')
          end as "forbiddenCompanyProfilesSelect",
          not exists (
            select 1
            from required_rls_tables required
            where not exists (
              select 1
              from pg_class relation
              join pg_namespace schema on schema.oid = relation.relnamespace
              where schema.nspname = 'public'
                and relation.relname = required.table_name
                and relation.relkind in ('r', 'p')
                and relation.relrowsecurity
                and relation.relforcerowsecurity
            )
          ) as "requiredRlsTablesProtected"
        from pg_roles runtime_role
        join pg_roles session_role on session_role.rolname = session_user
        join pg_database database on database.datname = current_database()
        where runtime_role.rolname = current_user
      `),
    ]);

    if (tableResult.status === "fulfilled") {
      tableStatus = tableResult.value;
    } else {
      tableCheckError = "table_check_failed";
    }

    if (ledgerResult.status === "fulfilled") {
      migrationLedger = ledgerResult.value;
    } else {
      migrationLedgerError = "migration_ledger_unavailable";
    }

    if (identityResult.status === "fulfilled" && identityResult.value[0]) {
      const identity = identityResult.value[0];
      const expectedNeonProjectId = process.env.POSTGRES_NEON_PROJECT_ID?.trim() || null;
      const bindingMatchesExpectedProject =
        expectedNeonProjectId !== null && identity.neonProjectId === expectedNeonProjectId;
      const leastPrivilege =
        !identity.superuser &&
        !identity.bypassRls &&
        !identity.createDatabase &&
        !identity.createRole &&
        !identity.replication &&
        !identity.sessionSuperuser &&
        !identity.sessionBypassRls &&
        !identity.sessionCreateDatabase &&
        !identity.sessionCreateRole &&
        !identity.sessionReplication &&
        !identity.databaseOwner &&
        !identity.sessionDatabaseOwner &&
        !identity.databaseCreate &&
        !identity.sessionDatabaseCreate &&
        !identity.schemaCreate &&
        !identity.sessionSchemaCreate &&
        !identity.readAllData &&
        !identity.sessionReadAllData &&
        !identity.writeAllData &&
        !identity.sessionWriteAllData &&
        identity.reachableElevatedRoles === 0 &&
        identity.tenantRuntimeMember &&
        identity.ownedOrInheritedPublicTables === 0 &&
        !identity.forbiddenCompanyProfilesSelect &&
        identity.requiredRlsTablesProtected;
      runtimeIdentity = { ...identity, bindingMatchesExpectedProject, leastPrivilege };
      console.info(JSON.stringify({
        correlationId,
        currentUser: identity.currentUser,
        database: identity.database,
        environment: process.env.VERCEL_ENV ?? null,
        event: "runtime_database_identity_proof",
        leastPrivilege,
        neonProjectId: identity.neonProjectId,
        sessionUser: identity.sessionUser,
      }));
    } else {
      runtimeIdentityError = "runtime_identity_unavailable";
      console.warn(JSON.stringify({
        correlationId,
        environment: process.env.VERCEL_ENV ?? null,
        event: "runtime_database_identity_proof",
        outcome: "unavailable",
      }));
    }
  }

  const missingTables = tableStatus.filter((table) => !table.exists).map((table) => table.tableName);
  const currentMigration = migrationLedger.at(-1)?.version ?? null;
  const runtimeProofPass =
    process.env.VERCEL_ENV === "production" &&
    runtimeIdentity?.leastPrivilege === true &&
    runtimeIdentity.bindingMatchesExpectedProject;

  return NextResponse.json(
    {
      ok: status.configured && missingTables.length === 0 && !tableCheckError && !migrationLedgerError,
      status,
      expectedTables: crmTables,
      migrationLedger,
      migrationLedgerError,
      migrationStatus: {
        checksumRows: migrationLedger.filter((migration) => Boolean(migration.checksum)).length,
        currentVersion: currentMigration,
        rows: migrationLedger.length,
      },
      missingTables,
      runtimeProof: {
        build: getBuildMetadata(),
        correlationId,
        environment: process.env.VERCEL_ENV ?? null,
        identity: runtimeIdentity,
        identityError: runtimeIdentityError,
        neonProjectId: process.env.POSTGRES_NEON_PROJECT_ID ?? null,
        status: runtimeProofPass ? "PASS" : "FAIL",
      },
      tableCheckError,
      tableStatus,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
