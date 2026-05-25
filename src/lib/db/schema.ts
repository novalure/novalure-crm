export const databaseEnv = {
  pooledUrl: "DATABASE_URL",
  directUrl: "POSTGRES_URL_NON_POOLING",
} as const;

export const crmTables = [
  "workspaces",
  "workspace_users",
  "auth_password_reset_tokens",
  "dashboard_views",
  "projects",
  "project_pipeline_permissions",
  "organizations",
  "contacts",
  "contact_relationships",
  "contact_timeline_items",
  "leads",
  "broker_mandates",
  "buyer_search_profiles",
  "seller_listings",
  "crm_pipelines",
  "crm_pipeline_stages",
  "property_buildings",
  "property_units",
  "property_reservations",
  "deals",
  "deal_stage_history",
  "customer_project_access",
  "tasks",
  "calendar_events",
  "funnels",
  "funnel_steps",
  "funnel_submissions",
  "forms",
  "form_submissions",
  "conversations",
  "bot_conversations",
  "bot_messages",
  "bot_tool_calls",
  "knowledge_sources",
  "knowledge_chunks",
  "newsletter_segments",
  "newsletter_campaigns",
  "newsletter_sends",
  "newsletter_suppressions",
  "consent_records",
  "consent_policy_decisions",
  "automations",
  "approval_requests",
  "lead_workflows",
  "lead_workflow_runs",
  "sequence_definitions",
  "sequence_steps",
  "sequence_enrollments",
  "sequence_step_runs",
  "sequence_events",
  "bot_language_rules",
  "bots",
  "bot_channel_accounts",
  "bot_channel_webhooks",
  "bot_document_sends",
  "call_insights",
  "bot_evaluation_runs",
  "provider_connections",
  "calendar_sync_events",
  "meeting_pages",
  "meeting_bookings",
  "meeting_notification_jobs",
  "teams_notification_targets",
  "teams_notification_jobs",
  "google_notification_targets",
  "google_notification_jobs",
  "media_assets",
  "customer_workspace_access",
  "speed_to_lead_events",
  "data_quality_issues",
  "crm_fallback_audits",
  "crm_follow_up_actions",
  "property_viewing_slots",
  "property_unit_audit_events",
  "property_offer_milestones",
  "bot_answer_quality_checks",
  "crm_conversion_snapshots",
  "customer_onboarding_risk_alerts",
  "data_quality_cleanup_actions",
  "crm_bulk_runtime_batches",
  "crm_permission_audit_runs",
  "crm_outreach_deliveries",
  "crm_operational_recommendation_runs",
  "pipeline_forecast_snapshots",
  "pipeline_bulk_actions",
  "editor_preflight_runs",
  "funnel_conversion_reports",
  "microsoft_booking_health_checks",
  "sequence_runtime_reviews",
  "analytics_events",
  "audit_logs",
] as const;

export type CrmTable = (typeof crmTables)[number];

export type DatabaseStatus =
  | { configured: true; pooledUrlEnv: string; directUrlEnv: string }
  | { configured: false; missing: string[] };

export function getDatabaseStatus(env: NodeJS.ProcessEnv = process.env): DatabaseStatus {
  const pooledUrlEnv = [
    databaseEnv.pooledUrl,
    "POSTGRES_URL",
    "POSTGRES_DATABASE_URL",
    "POSTGRES_PRISMA_URL",
  ].find((name) => Boolean(env[name]));
  const directUrlEnv = [
    databaseEnv.directUrl,
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_DATABASE_URL_UNPOOLED",
  ].find((name) => Boolean(env[name]));

  if (!pooledUrlEnv) {
    return { configured: false, missing: [databaseEnv.pooledUrl] };
  }

  return {
    configured: true,
    pooledUrlEnv,
    directUrlEnv: directUrlEnv ?? pooledUrlEnv,
  };
}
