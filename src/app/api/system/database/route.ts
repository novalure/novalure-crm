import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { queryRows } from "@/lib/db/client";
import { crmTables, getDatabaseStatus } from "@/lib/db/schema";
import { hasProductCapability } from "@/lib/product-model";

const migrations = [
  "migrations/001_initial_novalure_crm.sql",
  "migrations/002_product_runtime.sql",
  "migrations/003_media_storage.sql",
  "migrations/004_forms_runtime.sql",
  "migrations/005_meeting_pages.sql",
  "migrations/006_meeting_bookings.sql",
  "migrations/007_bot_omnichannel_agents.sql",
  "migrations/008_meeting_calendar_integrations.sql",
  "migrations/009_bot_autonomy_policy.sql",
  "migrations/010_media_public_shares.sql",
  "migrations/011_customer_meta_channel_accounts.sql",
  "migrations/012_lead_sequences.sql",
  "migrations/013_analysis_bot_70_sprint.sql",
  "migrations/013_newsletter_suppressions.sql",
  "migrations/014_password_reset.sql",
  "migrations/015_pipeline_governance.sql",
  "migrations/016_teams_notifications.sql",
  "migrations/017_google_meet_notifications.sql",
  "migrations/018_crm_analytics_events.sql",
  "migrations/019_customer_access_cockpit.sql",
  "migrations/020_production_readiness_repair.sql",
  "migrations/021_reservation_workflow_notifications.sql",
  "migrations/022_recommendation_runtime.sql",
  "migrations/023_recommendation_depth.sql",
  "migrations/024_follow_up_delivery_runtime.sql",
  "migrations/025_analysis_recommendation_completion.sql",
  "migrations/026_workspace_operating_model.sql",
  "migrations/027_broker_pipeline_preflights.sql",
  "migrations/028_contact_archiving.sql",
  "migrations/029_contact_owner_scope.sql",
  "migrations/030_novalure_growth_workspace.sql",
  "migrations/031_user_onboarding.sql",
  "migrations/032_public_slug_routing.sql",
  "migrations/033_rename_demo_form_source.sql",
  "migrations/034_property_department.sql",
  "migrations/035_property_department_content.sql",
  "migrations/036_company_profiles.sql",
  "migrations/037_novalure_growth_alignment.sql",
];

type TableStatusRow = {
  exists: boolean;
  tableName: string;
};

function isProductionDiagnosticsRestricted() {
  return process.env.VERCEL_ENV === "production" || process.env.NOVALURE_RESTRICT_SYSTEM_DIAGNOSTICS === "1";
}

function canViewSystemDiagnostics(session: Awaited<ReturnType<typeof getRequestSession>>) {
  if (!session) return false;
  return session.productRole === "platform_admin" || hasProductCapability(session.productRole, "novalure:internal");
}

export async function GET(request: Request) {
  const status = getDatabaseStatus();

  if (isProductionDiagnosticsRestricted()) {
    const session = await getRequestSession(request);
    if (!canViewSystemDiagnostics(session)) {
      return NextResponse.json({
        ok: status.configured,
      });
    }
  }

  let tableStatus: TableStatusRow[] = [];
  let tableCheckError: string | null = null;

  if (status.configured) {
    try {
      tableStatus = await queryRows<TableStatusRow>(
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
      );
    } catch (error) {
      tableCheckError = error instanceof Error ? error.message : "Table check failed";
    }
  }

  const missingTables = tableStatus.filter((table) => !table.exists).map((table) => table.tableName);

  return NextResponse.json({
    ok: status.configured && missingTables.length === 0 && !tableCheckError,
    status,
    expectedTables: crmTables,
    migrations,
    missingTables,
    tableCheckError,
    tableStatus,
  });
}
