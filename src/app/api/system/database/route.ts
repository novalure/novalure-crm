import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { queryRows } from "@/lib/db/client";
import { getMigrationLedgerStatus } from "@/lib/db/migration-status";
import { crmTables, getDatabaseStatus } from "@/lib/db/schema";
import { hasProductCapability } from "@/lib/product-model";

const requiredIndexes = [
  "property_reservations_one_active_per_unit_idx",
  "property_reservations_workspace_idempotency_uidx",
  "auth_rate_limits_cleanup_idx",
  "media_assets_public_token_uidx",
  "media_private_migration_manifest_status_idx",
  "teams_notification_jobs_lease_idx",
  "google_notification_jobs_lease_idx",
  "meeting_notification_jobs_lease_idx",
] as const;

type TableStatusRow = { exists: boolean; tableName: string };
type IndexStatusRow = { exists: boolean; indexName: string };

function isRestricted() {
  return process.env.VERCEL_ENV === "production" || process.env.NOVALURE_RESTRICT_SYSTEM_DIAGNOSTICS === "1";
}

function canViewDetails(session: Awaited<ReturnType<typeof getRequestSession>>) {
  return Boolean(session && (
    session.productRole === "platform_admin" || hasProductCapability(session.productRole, "novalure:internal")
  ));
}

async function inspectDatabase() {
  const configuration = getDatabaseStatus();
  if (!configuration.configured) {
    return { configuration, error: "database_not_configured", ok: false };
  }

  try {
    const expectedTables = [...crmTables, "auth_rate_limits", "novalure_schema_migrations"];
    const [tableStatus, indexStatus, migrations] = await Promise.all([
      queryRows<TableStatusRow>(
        `
          select expected.table_name as "tableName", to_regclass('public.' || expected.table_name) is not null as "exists"
          from unnest($1::text[]) expected(table_name)
          order by expected.table_name
        `,
        [expectedTables],
      ),
      queryRows<IndexStatusRow>(
        `
          select expected.index_name as "indexName", to_regclass('public.' || expected.index_name) is not null as "exists"
          from unnest($1::text[]) expected(index_name)
          order by expected.index_name
        `,
        [[...requiredIndexes]],
      ),
      getMigrationLedgerStatus(),
    ]);
    const missingTables = tableStatus.filter((item) => !item.exists).map((item) => item.tableName);
    const missingIndexes = indexStatus.filter((item) => !item.exists).map((item) => item.indexName);
    const ok = migrations.ledgerExists
      && migrations.pending.length === 0
      && migrations.checksumMismatches.length === 0
      && migrations.collisions.length === 0
      && missingTables.length === 0
      && missingIndexes.length === 0;
    return { configuration, indexStatus, migrations, missingIndexes, missingTables, ok, tableStatus };
  } catch (error) {
    return {
      configuration,
      error: error instanceof Error ? error.message : "database_inspection_failed",
      ok: false,
    };
  }
}

export async function GET(request: Request) {
  const inspection = await inspectDatabase();
  const response = isRestricted() && !canViewDetails(await getRequestSession(request))
    ? NextResponse.json({ ok: inspection.ok })
    : NextResponse.json(inspection);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
