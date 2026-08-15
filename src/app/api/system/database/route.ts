import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
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

  if (status.configured) {
    const [tableResult, ledgerResult] = await Promise.allSettled([
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
  }

  const missingTables = tableStatus.filter((table) => !table.exists).map((table) => table.tableName);
  const currentMigration = migrationLedger.at(-1)?.version ?? null;

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
      tableCheckError,
      tableStatus,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
