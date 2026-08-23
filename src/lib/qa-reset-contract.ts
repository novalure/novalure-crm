import type { AppPermission, AppRole } from "./auth/permissions";
import type { ProductCapability, ProductRole } from "./product-model";

export const qaResetModes = ["dry_run", "execute"] as const;
export type QaResetMode = (typeof qaResetModes)[number];

export type QaResetRequest = Readonly<{
  batchId: string;
  confirmation: string | null;
  expectedPlanDigest: string | null;
  mode: QaResetMode;
  workspaceId: string;
}>;

export type QaResetSession = Readonly<{
  permissions: readonly AppPermission[];
  productPermissions: readonly ProductCapability[];
  productRole: ProductRole;
  role: AppRole;
  source: "cookie" | "database" | "demo" | "headers";
}>;

export type QaResetContractErrorCode =
  | "invalid_payload"
  | "invalid_batch_id"
  | "invalid_workspace_id"
  | "unsupported_mode"
  | "unexpected_field"
  | "execution_not_enabled"
  | "invalid_confirmation"
  | "invalid_plan_digest"
  | "plan_digest_required"
  | "production_denylist_not_configured"
  | "qa_allowlist_not_configured"
  | "qa_allowlist_too_small"
  | "qa_production_allowlist_overlap"
  | "workspace_not_allowlisted";

export class QaResetContractError extends Error {
  readonly code: QaResetContractErrorCode;

  constructor(code: QaResetContractErrorCode, message: string) {
    super(message);
    this.name = "QaResetContractError";
    this.code = code;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const planDigestPattern = /^[0-9a-f]{64}$/i;

const requestFields = new Set(["batchId", "confirmation", "expectedPlanDigest", "mode", "workspaceId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredUuid(value: unknown, code: "invalid_batch_id" | "invalid_workspace_id") {
  if (typeof value !== "string" || !uuidPattern.test(value.trim())) {
    throw new QaResetContractError(code, code === "invalid_batch_id" ? "Invalid QA batch id" : "Invalid QA workspace id");
  }

  return value.trim().toLowerCase();
}

export function parseQaResetRequest(value: unknown): QaResetRequest {
  if (!isRecord(value)) {
    throw new QaResetContractError("invalid_payload", "QA reset payload must be an object");
  }

  for (const key of Object.keys(value)) {
    if (!requestFields.has(key)) {
      throw new QaResetContractError("unexpected_field", `Unsupported QA reset field: ${key.slice(0, 80)}`);
    }
  }

  const mode = value.mode === undefined ? "dry_run" : value.mode;
  if (mode !== "dry_run" && mode !== "execute") {
    throw new QaResetContractError("unsupported_mode", "QA reset mode must be dry_run or execute");
  }
  if (value.confirmation !== undefined && value.confirmation !== null && typeof value.confirmation !== "string") {
    throw new QaResetContractError("invalid_confirmation", "QA reset confirmation must be a string");
  }
  if (
    value.expectedPlanDigest !== undefined &&
    value.expectedPlanDigest !== null &&
    (typeof value.expectedPlanDigest !== "string" || !planDigestPattern.test(value.expectedPlanDigest.trim()))
  ) {
    throw new QaResetContractError("invalid_plan_digest", "QA reset plan digest must be a SHA-256 hex digest");
  }

  return {
    batchId: requiredUuid(value.batchId, "invalid_batch_id"),
    confirmation: typeof value.confirmation === "string" ? value.confirmation : null,
    expectedPlanDigest:
      typeof value.expectedPlanDigest === "string" ? value.expectedPlanDigest.trim().toLowerCase() : null,
    mode,
    workspaceId: requiredUuid(value.workspaceId, "invalid_workspace_id"),
  };
}

function parseUuidSet(value: string | undefined) {
  const result = new Set<string>();
  for (const candidate of (value ?? "").split(",")) {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) continue;
    if (!uuidPattern.test(normalized)) {
      throw new QaResetContractError("qa_allowlist_not_configured", "QA workspace allowlist contains an invalid UUID");
    }
    result.add(normalized);
  }
  return result;
}

export function resolveQaResetWorkspaceAllowlist(env: NodeJS.ProcessEnv = process.env) {
  const qaWorkspaceIds = parseUuidSet(env.NOVALURE_QA_RESET_WORKSPACE_IDS);
  if (qaWorkspaceIds.size === 0) {
    throw new QaResetContractError("qa_allowlist_not_configured", "NOVALURE_QA_RESET_WORKSPACE_IDS is required");
  }
  if (qaWorkspaceIds.size < 2) {
    throw new QaResetContractError("qa_allowlist_too_small", "At least two isolated QA workspaces must be allowlisted");
  }

  const productionWorkspaceIds = parseUuidSet(env.NOVALURE_PRODUCTION_WORKSPACE_IDS);
  if (productionWorkspaceIds.size === 0) {
    throw new QaResetContractError(
      "production_denylist_not_configured",
      "NOVALURE_PRODUCTION_WORKSPACE_IDS is required",
    );
  }
  for (const workspaceId of qaWorkspaceIds) {
    if (productionWorkspaceIds.has(workspaceId)) {
      throw new QaResetContractError(
        "qa_production_allowlist_overlap",
        "A workspace cannot be present in both QA and production allowlists",
      );
    }
  }

  return qaWorkspaceIds;
}

export function assertQaResetWorkspaceAllowlisted(workspaceId: string, allowlist: ReadonlySet<string>) {
  if (!allowlist.has(workspaceId.toLowerCase())) {
    throw new QaResetContractError("workspace_not_allowlisted", "QA workspace is not allowlisted");
  }
}

export function canAdministerQaReset(session: QaResetSession) {
  return (
    session.source === "cookie" &&
    session.role === "owner" &&
    session.productRole === "platform_admin" &&
    session.permissions.includes("settings:manage") &&
    session.productPermissions.includes("novalure:internal") &&
    session.productPermissions.includes("settings:manage")
  );
}

export function qaResetConfirmation(input: Pick<QaResetRequest, "batchId" | "workspaceId">) {
  return `RESET QA BATCH ${input.workspaceId} ${input.batchId}`;
}

export function assertQaResetExecutionAuthorized(
  request: QaResetRequest,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (request.mode !== "execute") return;
  if (env.NOVALURE_QA_RESET_EXECUTION_ENABLED?.trim().toLowerCase() !== "true") {
    throw new QaResetContractError("execution_not_enabled", "QA reset execution is disabled");
  }
  if (request.confirmation !== qaResetConfirmation(request)) {
    throw new QaResetContractError("invalid_confirmation", "QA reset confirmation does not match workspace and batch");
  }
  if (!request.expectedPlanDigest) {
    throw new QaResetContractError(
      "plan_digest_required",
      "QA reset execution requires the exact plan digest returned by a preceding dry-run",
    );
  }
}

export function isQaResetPlanDigest(value: unknown): value is string {
  return typeof value === "string" && planDigestPattern.test(value);
}

/**
 * Database-backed business/runtime rows that may be removed only when their
 * exact ids are registered in the requested append-only QA batch ledger.
 */
export const qaResetDatabaseTables = [
  "workspace_lead_sources",
  "workspace_module_settings",
  "company_profiles",
  "company_profile_versions",
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
  "property_media",
  "property_documents",
  "property_channels",
  "property_inquiries",
  "property_export_jobs",
  "property_openimmo_mappings",
  "property_data_quality_issues",
  "property_activity_events",
  "property_text_blocks",
  "property_cost_items",
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
  "bot_answer_quality_checks",
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
  "media_asset_shares",
  "customer_workspace_access",
  "speed_to_lead_events",
  "data_quality_issues",
  "crm_follow_up_actions",
  "property_viewing_slots",
  "property_offer_milestones",
  "crm_conversion_snapshots",
  "customer_onboarding_risk_alerts",
  "data_quality_cleanup_actions",
  "crm_bulk_runtime_batches",
  "crm_outreach_deliveries",
  "crm_operational_recommendation_runs",
  "pipeline_forecast_snapshots",
  "pipeline_bulk_actions",
  "editor_preflight_runs",
  "funnel_conversion_reports",
  "microsoft_booking_health_checks",
  "sequence_runtime_reviews",
] as const;

export type QaResetDatabaseTable = (typeof qaResetDatabaseTables)[number];

/**
 * Derived rows that are never direct batch targets. Their database FKs must
 * use ON DELETE CASCADE so deleting a registered parent removes them inside
 * the same reset transaction without weakening exact-id checks for business
 * objects.
 */
export const qaResetCascadeOwnedTables = [
  "property_building_idempotency",
  "property_unit_idempotency",
  "public_funnel_visit_events",
] as const;

export type QaResetCascadeOwnedTable = (typeof qaResetCascadeOwnedTables)[number];

/**
 * Deliberately retained roots/evidence. They are not accepted as deletion
 * targets and must be reconciled separately from operational business counts.
 */
export const qaResetRetainedTables = [
  "workspaces",
  "workspace_users",
  "auth_password_reset_tokens",
  "auth_identities",
  "auth_sessions",
  "auth_login_challenges",
  "auth_mfa_recovery_codes",
  "auth_rate_limit_buckets",
  "auth_password_reset_exchanges",
  "auth_audit_events",
  "audit_logs",
  "analytics_events",
  "crm_fallback_audits",
  "property_unit_audit_events",
  "bot_evaluation_runs",
  "crm_permission_audit_runs",
  "csrf_token_consumptions",
  "oauth_authorization_states",
  "public_submission_rate_limits",
  "public_submission_idempotency",
  "novalure_schema_migrations",
  "qa_batches",
  "qa_batch_objects",
  "qa_reset_audit_events",
] as const;

export type QaResetRetainedTable = (typeof qaResetRetainedTables)[number];

export const qaResetTableSet: ReadonlySet<string> = new Set(qaResetDatabaseTables);
export const qaResetCascadeOwnedTableSet: ReadonlySet<string> = new Set(qaResetCascadeOwnedTables);
export const qaResetRetainedTableSet: ReadonlySet<string> = new Set(qaResetRetainedTables);

export function isQaResetDatabaseTable(value: string): value is QaResetDatabaseTable {
  return qaResetTableSet.has(value);
}

export function isQaResetRetainedTable(value: string): value is QaResetRetainedTable {
  return qaResetRetainedTableSet.has(value);
}

export function isQaResetCascadeOwnedTable(value: string): value is QaResetCascadeOwnedTable {
  return qaResetCascadeOwnedTableSet.has(value);
}

export function isUuid(value: string) {
  return uuidPattern.test(value);
}
