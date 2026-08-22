import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { queryRows } from "@/lib/db/client";
import { crmTables, getDatabaseStatus } from "@/lib/db/schema";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export type TableStatusRow = {
  exists: boolean;
  tableName: string;
};

export type MigrationLedgerRow = {
  appliedAt: string | Date;
  checksum: string | null;
  name: string;
  version: string;
};

export type SystemDatabaseDiagnosticIssue = {
  code:
    | "database_not_configured"
    | "migration_checksum_incomplete"
    | "migration_current_version_missing"
    | "migration_ledger_empty"
    | "migration_ledger_unavailable"
    | "missing_tables"
    | "table_check_failed"
    | "table_inventory_incomplete";
  detail?: string;
};

export type SystemDatabaseDiagnostics = {
  expectedTables: string[];
  issues: SystemDatabaseDiagnosticIssue[];
  migrationLedger: MigrationLedgerRow[];
  migrationLedgerError: string | null;
  migrationStatus: {
    checksumRows: number;
    currentVersion: string | null;
    rows: number;
  };
  missingTables: string[];
  ok: boolean;
  status: ReturnType<typeof getDatabaseStatus>;
  tableCheckError: string | null;
  tableStatus: TableStatusRow[];
};

function canViewSystemDiagnostics(session: Awaited<ReturnType<typeof getRequestSession>>) {
  if (!session) return false;
  return evaluateLaunchScope("systemDatabaseDiagnostics", session).allowed;
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
  const currentMigration = migrationLedger.at(-1)?.version?.trim() || null;
  const checksumRows = migrationLedger.filter((migration) => Boolean(migration.checksum?.trim())).length;
  const issues: SystemDatabaseDiagnosticIssue[] = [];

  if (!status.configured) {
    issues.push({ code: "database_not_configured", detail: status.missing.join(", ") });
  } else {
    if (tableCheckError) {
      issues.push({ code: "table_check_failed" });
    } else if (tableStatus.length !== crmTables.length) {
      issues.push({
        code: "table_inventory_incomplete",
        detail: `${tableStatus.length}/${crmTables.length}`,
      });
    }

    if (missingTables.length > 0) {
      issues.push({ code: "missing_tables", detail: missingTables.join(", ") });
    }

    if (migrationLedgerError) {
      issues.push({ code: "migration_ledger_unavailable" });
    } else if (migrationLedger.length === 0) {
      issues.push({ code: "migration_ledger_empty" });
    } else {
      if (!currentMigration) {
        issues.push({ code: "migration_current_version_missing" });
      }
      if (checksumRows !== migrationLedger.length) {
        issues.push({
          code: "migration_checksum_incomplete",
          detail: `${checksumRows}/${migrationLedger.length}`,
        });
      }
    }
  }

  const response: SystemDatabaseDiagnostics = {
    expectedTables: [...crmTables],
    issues,
    migrationLedger,
    migrationLedgerError,
    migrationStatus: {
      checksumRows,
      currentVersion: currentMigration,
      rows: migrationLedger.length,
    },
    missingTables,
    ok: issues.length === 0,
    status,
    tableCheckError,
    tableStatus,
  };

  return NextResponse.json(
    response,
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
