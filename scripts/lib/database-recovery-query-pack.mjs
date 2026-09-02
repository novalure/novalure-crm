import { createHash } from "node:crypto";
import { recoveryMigrationPlan } from "./recovery-migration-plan.mjs";

export const recoveryQueryPackVersion = 2;
export const recoveryExpectedProjectId = "misty-cloud-70835427";
export const recoveryExpectedProductionBranchId = "br-snowy-fog-aldx77v8";
export const recoveryExpectedDatabaseName = "neondb";
export const recoveryExpectedMigrationRoleName = "neondb_owner";

export const recoveryBaselineMigrationPlan = Object.freeze([
  Object.freeze({ checksum: "24f8937ca066775e7cc93e6ea61c07798183e143c3bd0e04023f7ee7c8f93045", version: "041_schema_ledger_baseline" }),
  Object.freeze({ checksum: "c51f01cfe6a8081e2d741b733b79ae7ddfc7795a2d86143c3b8442b69118b38f", version: "042_teams_notification_reservation_workflow_constraint" }),
  Object.freeze({ checksum: "a3c0f025781067cb22f1fc7c09a5b5dd14c7cd368993695a8d98a1b1f71238d6", version: "043_leads_idempotency" }),
  Object.freeze({ checksum: "e94833d9e8bf85c537a585e2f05216b33503a36eadd0154292e692bbc3bb231c", version: "044_fk_performance_indexes" }),
  Object.freeze({ checksum: "caa10d953f41f0f9a4a9351c5cea3c27a6ddc2c62cea2dfb3b63836310c6a2db", version: "045_media_schema" }),
  Object.freeze({ checksum: "39b4a114922912de86192dccab8740441b92511651c33c925d5456b628535ec9", version: "046_schema_residual_reconciliation" }),
  Object.freeze({ checksum: "ef1309f10a9772ea934e401f039035dd36035014460e66daee8c38b484d3d5a6", version: "047_deals_idempotency" }),
  Object.freeze({ checksum: "f5993d9f44ad61f71862570a702c14a7f549269f0a30b57bc007e57b06115b9d", version: "048_bot_webhook_integrity" }),
  Object.freeze({ checksum: "ffd4be362a4a25a324067c0621a3de8438d0da97d02acf41159b6e8f7eed942b", version: "049_property_inventory_tenant_guards" }),
  Object.freeze({ checksum: "62dc4b16f770aadeb5e4557a90fe34d93d62e859494aed806d8e7a9d742f4439", version: "050_durable_job_leasing" }),
  Object.freeze({ checksum: "2222942814ab1db328acee645439f9dd9ec2200be4ca3b01d133601ae1f4c12b", version: "051_private_media_access" }),
  Object.freeze({ checksum: "a8f10a4f62e10da8e4c099383decc3805520a1d755e1c8c2a2994f297aeb0233", version: "052_validate_property_inventory_tenant_guards" }),
  Object.freeze({ checksum: "c78f509d09ddb6ff8f6d445e60c2d06e0620c578f1e7a1995c5f8b189d881b28", version: "053_oauth_state_integrity" }),
  Object.freeze({ checksum: "d6cba6c9cd616c4b4a52ecc3b251f412150d479cefcd2fc71abd90de99ae5504", version: "054_csrf_token_integrity" }),
  Object.freeze({ checksum: "f0ddb2b3103ba7d6d70b5a41883f768831b1cffc3fc8d689254aa408ca0ac358", version: "055_public_submission_abuse_guards" }),
  Object.freeze({ checksum: "621d5c856a80ab10b4700642e53d42e821a6c7b9048ad434200df5caec66deba", version: "056_auth_identity_sessions_mfa" }),
  Object.freeze({ checksum: "bb70c95a27cedc065535e689390036262084759aed7e3fd932d12a5c61ae130e", version: "064_notification_provider_and_lead_assignee_integrity" }),
  Object.freeze({ checksum: "dca5893b5bf788b1b0ecac798b0ed965977678b5ca5a6e37b936214dcce717f0", version: "066_oauth_state_workspace_user_guard" }),
  Object.freeze({ checksum: "c48afb3409308f74ee03743ec0932c7fc3460bf3085c55c5b8ae753c545f2f3e", version: "067_app_role_runtime_grants" }),
]);

const addedDefaultProjections = Object.freeze({
  approval_requests: "to_jsonb(t) - 'webhook_event_id'",
  audit_logs: "to_jsonb(t) - array['webhook_event_id', 'after']",
  bot_conversations: "to_jsonb(t) - 'webhook_event_id'",
  bot_document_sends: "to_jsonb(t) - array['webhook_event_id', 'metadata']",
  bot_messages: "to_jsonb(t) - 'webhook_event_id'",
  bot_tool_calls: "to_jsonb(t) - 'webhook_event_id'",
  buyer_search_profiles: `to_jsonb(t) - array[
    'organization_id', 'owner_user_id', 'expires_at', 'intent_type', 'sub_object_type',
    'area_from_sqm', 'area_to_sqm', 'rooms_from', 'rooms_to', 'region', 'municipality',
    'postal_code', 'radius_km', 'year_built_from', 'year_built_to', 'equipment',
    'accessibility', 'target_yield_basis_points', 'exclusion_criteria',
    'auto_match_enabled', 'status', 'version', 'broker_operations_managed'
  ]`,
  contact_timeline_items: `to_jsonb(t) - array[
    'webhook_event_id', 'activity_type', 'lead_id', 'property_id', 'unit_id', 'deal_id',
    'reservation_id', 'offer_id', 'viewing_id', 'closing_id', 'owner_user_id', 'version',
    'broker_operations_managed'
  ]`,
  crm_bulk_runtime_batches: `to_jsonb(t) - array[
    'actor_user_id', 'idempotency_key', 'request_sha256', 'status', 'selection_ids',
    'payload', 'completed_at', 'error', 'updated_at'
  ]`,
  form_submissions: "to_jsonb(t) - array['idempotency_key', 'request_hash', 'response_payload', 'claim_lease_version']",
  funnel_submissions: "to_jsonb(t) - 'idempotency_key'",
  media_assets: `to_jsonb(t) - array[
    'url', 'public_token', 'deletion_state', 'deletion_requested_at',
    'deletion_requested_by_user_id', 'created_by_user_id'
  ]`,
  property_channels: "to_jsonb(t) - 'runtime_key'",
  property_export_jobs: `to_jsonb(t) - array[
    'operation', 'provider_key', 'payload_snapshot', 'payload_sha256', 'snapshot_captured_at',
    'artifact_payload', 'artifact_sha256', 'artifact_content_type', 'artifact_filename',
    'provider_request_id', 'provider_acknowledged_at', 'result_metadata'
  ]`,
  property_viewing_slots: `to_jsonb(t) - array[
    'target_kind', 'property_id', 'timezone', 'address_mode', 'address_text', 'personal_note',
    'internal_note', 'invitation_status', 'reminder_at', 'cancellation_reason',
    'calendar_event_id', 'version', 'broker_operations_managed'
  ]`,
  public_submission_idempotency: "to_jsonb(t) - 'lease_version'",
  seller_listings: "to_jsonb(t) - 'metadata'",
  tasks: `to_jsonb(t) - array[
    'broker_activity_id', 'property_id', 'unit_id', 'deal_id', 'reservation_id',
    'offer_id', 'viewing_id', 'closing_id'
  ]`,
  workspaces: "to_jsonb(t) - 'is_qa'",
});

const createdTables = new Set([
  "broker_closing_participants",
  "broker_closings",
  "broker_commission_splits",
  "broker_offer_deliveries",
  "broker_offer_items",
  "broker_offer_versions",
  "broker_offers",
  "broker_operation_requests",
  "broker_viewing_history",
  "bot_channel_webhook_envelopes",
  "buyer_match_decisions",
  "buyer_match_evaluations",
  "crm_bulk_runtime_batch_items",
  "crm_communication_template_versions",
  "crm_communication_templates",
  "crm_content_document_versions",
  "crm_content_documents",
  "crm_content_links",
  "crm_recent_records",
  "crm_safe_mutation_requests",
  "crm_saved_views",
  "privacy_data_subject_requests",
  "privacy_legal_holds",
  "privacy_retention_policies",
  "privacy_retention_reviews",
  "property_building_idempotency",
  "property_export_job_events",
  "property_unit_idempotency",
  "public_funnel_visit_events",
  "qa_batch_objects",
  "qa_batches",
  "qa_reset_audit_events",
]);

const intentionalUnvalidatedRecoveryConstraintNames = Object.freeze([
  "buyer_search_profiles_accessibility_check",
  "buyer_search_profiles_broker_contact_fk",
  "buyer_search_profiles_broker_lead_fk",
  "buyer_search_profiles_broker_organization_fk",
  "buyer_search_profiles_broker_owner_fk",
  "buyer_search_profiles_broker_project_fk",
  "buyer_search_profiles_broker_status_check",
  "buyer_search_profiles_intent_type_check",
  "buyer_search_profiles_ranges_check",
  "contact_timeline_items_broker_activity_type_check",
  "contact_timeline_items_broker_closing_fk",
  "contact_timeline_items_broker_contact_fk",
  "contact_timeline_items_broker_deal_fk",
  "contact_timeline_items_broker_lead_fk",
  "contact_timeline_items_broker_offer_fk",
  "contact_timeline_items_broker_owner_fk",
  "contact_timeline_items_broker_project_fk",
  "contact_timeline_items_broker_property_fk",
  "contact_timeline_items_broker_reservation_fk",
  "contact_timeline_items_broker_unit_fk",
  "contact_timeline_items_broker_version_check",
  "contact_timeline_items_broker_viewing_fk",
  "crm_bulk_runtime_batches_idempotency_shape_check",
  "crm_bulk_runtime_batches_request_sha256_check",
  "crm_bulk_runtime_batches_workspace_actor_fk",
  "leads_qualifying_requires_assignee_check",
  "property_channels_workspace_last_export_fk",
  "property_channels_workspace_project_fk",
  "property_channels_workspace_property_fk",
  "property_channels_workspace_unit_fk",
  "property_export_job_events_workspace_actor_fk",
  "property_export_job_events_workspace_job_fk",
  "property_export_jobs_artifact_sha256_check",
  "property_export_jobs_payload_sha256_check",
  "property_export_jobs_runtime_shape_check",
  "property_export_jobs_workspace_channel_fk",
  "property_export_jobs_workspace_project_fk",
  "property_export_jobs_workspace_property_fk",
  "property_export_jobs_workspace_starter_fk",
  "property_export_jobs_workspace_unit_fk",
  "property_viewing_slots_broker_address_mode_check",
  "property_viewing_slots_broker_calendar_fk",
  "property_viewing_slots_broker_contact_fk",
  "property_viewing_slots_broker_deal_fk",
  "property_viewing_slots_broker_invitation_status_check",
  "property_viewing_slots_broker_lead_fk",
  "property_viewing_slots_broker_owner_fk",
  "property_viewing_slots_broker_project_fk",
  "property_viewing_slots_broker_property_fk",
  "property_viewing_slots_broker_target_check",
  "property_viewing_slots_broker_unit_fk",
  "property_viewing_slots_broker_version_check",
  "tasks_broker_activity_fk",
  "tasks_broker_closing_fk",
  "tasks_broker_deal_fk",
  "tasks_broker_offer_fk",
  "tasks_broker_property_fk",
  "tasks_broker_reservation_fk",
  "tasks_broker_unit_fk",
  "tasks_broker_viewing_fk",
]);

const intentionalConstraintTablePrefixes = Object.freeze([
  "buyer_search_profiles",
  "contact_timeline_items",
  "crm_bulk_runtime_batches",
  "leads",
  "property_channels",
  "property_export_job_events",
  "property_export_jobs",
  "property_viewing_slots",
  "tasks",
]);

export const intentionalUnvalidatedRecoveryConstraints = Object.freeze(
  intentionalUnvalidatedRecoveryConstraintNames.map((constraintName) => {
    const tableName = intentionalConstraintTablePrefixes.find(
      (prefix) => constraintName.startsWith(`${prefix}_`),
    );
    if (!tableName) throw new Error(`RECOVERY_CONSTRAINT_TABLE_UNMAPPED:${constraintName}`);
    return Object.freeze({
      constraintName,
      tableName: `public.${tableName}`,
    });
  }),
);

const deterministicTransformProjections = Object.freeze({
  bot_channel_webhooks: `jsonb_build_object(
    'id', t.id,
    'workspace_id', t.workspace_id,
    'channel_account_id', t.channel_account_id,
    'channel', t.channel,
    'contact_ref', t.contact_ref,
    'event_type', t.event_type,
    'payload', t.payload,
    'normalized_message', t.normalized_message,
    'received_at', t.received_at
  )`,
  company_profiles: `jsonb_build_object(
    'id', t.id,
    'profile_scope', t.profile_scope,
    'workspace_id', t.workspace_id,
    'organization_id', t.organization_id,
    'legal_name', t.legal_name,
    'display_name', t.display_name,
    'legal_form', t.legal_form,
    'country_code', t.country_code,
    'jurisdiction', t.jurisdiction,
    'registration_number', t.registration_number,
    'registration_authority', t.registration_authority,
    'register_court', t.register_court,
    'vat_id', t.vat_id,
    'tax_number', t.tax_number,
    'registered_office_address', t.registered_office_address,
    'business_address', t.business_address,
    'billing_address', t.billing_address,
    'public_email', t.public_email,
    'public_phone', t.public_phone,
    'website', t.website,
    'representatives', t.representatives,
    'privacy_contact', t.privacy_contact,
    'dpo_contact', t.dpo_contact,
    'licenses', t.licenses,
    'brand', t.brand,
    'usage_settings', t.usage_settings,
    'created_at', t.created_at
  )`,
});

const migrationTouchedTables = Object.freeze([
  "approval_requests",
  "audit_logs",
  "broker_closing_participants",
  "broker_closings",
  "broker_commission_splits",
  "broker_offer_deliveries",
  "broker_offer_items",
  "broker_offer_versions",
  "broker_offers",
  "broker_operation_requests",
  "broker_viewing_history",
  "bot_channel_webhook_envelopes",
  "bot_channel_webhooks",
  "bot_conversations",
  "bot_document_sends",
  "bot_messages",
  "bot_tool_calls",
  "bots",
  "buyer_match_decisions",
  "buyer_match_evaluations",
  "buyer_search_profiles",
  "calendar_events",
  "company_profiles",
  "contact_timeline_items",
  "contacts",
  "crm_bulk_runtime_batch_items",
  "crm_bulk_runtime_batches",
  "crm_communication_template_versions",
  "crm_communication_templates",
  "crm_content_document_versions",
  "crm_content_documents",
  "crm_content_links",
  "crm_recent_records",
  "crm_safe_mutation_requests",
  "crm_saved_views",
  "deals",
  "form_submissions",
  "forms",
  "funnel_steps",
  "funnel_submissions",
  "funnels",
  "google_notification_jobs",
  "google_notification_targets",
  "leads",
  "media_asset_shares",
  "media_assets",
  "organizations",
  "privacy_data_subject_requests",
  "privacy_legal_holds",
  "privacy_retention_policies",
  "privacy_retention_reviews",
  "projects",
  "property_activity_events",
  "property_buildings",
  "property_building_idempotency",
  "property_channels",
  "property_documents",
  "property_export_job_events",
  "property_export_jobs",
  "property_inquiries",
  "property_media",
  "property_reservations",
  "property_unit_idempotency",
  "property_units",
  "property_viewing_slots",
  "public_funnel_visit_events",
  "public_submission_idempotency",
  "qa_batch_objects",
  "qa_batches",
  "qa_reset_audit_events",
  "seller_listings",
  "tasks",
  "teams_notification_jobs",
  "teams_notification_targets",
  "workspace_users",
  "workspaces",
]);

function tableSpec(name) {
  const policy = createdTables.has(name)
    ? "CREATED_EMPTY"
    : Object.hasOwn(deterministicTransformProjections, name)
      ? "DETERMINISTIC_TRANSFORM"
      : Object.hasOwn(addedDefaultProjections, name)
        ? "ADDED_DEFAULT_COLUMNS"
        : "UNCHANGED";
  const rowProjectionSql = deterministicTransformProjections[name]
    ?? addedDefaultProjections[name]
    ?? "to_jsonb(t)";
  return Object.freeze({
    name,
    policy,
    presenceSql: `select to_regclass('public.${name}') is not null as present`,
    projectionId: `${name}:${policy.toLowerCase()}:v1`,
    rowProjectionSql,
    sql: `select ${rowProjectionSql} as row from public.${name} as t`,
  });
}

export const recoveryTableQuerySpecs = Object.freeze(migrationTouchedTables.map(tableSpec));
export const recoveryEvidenceTableNames = Object.freeze(recoveryTableQuerySpecs.map(({ name }) => name));
export const recoveryTransformationTableNames = Object.freeze(
  recoveryTableQuerySpecs
    .filter(({ policy }) => policy === "ADDED_DEFAULT_COLUMNS" || policy === "DETERMINISTIC_TRANSFORM")
    .map(({ name }) => name),
);

const transformationQueries = Object.freeze({
  approval_requests: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.approval_requests",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.approval_requests",
  }),
  audit_logs: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id, 'after', after) as row from public.audit_logs",
    expectedSql: `select jsonb_build_object(
      'id', id,
      'webhook_event_id', null,
      'after', case
        when action = 'bot.document_send.attach_media_asset'
          and jsonb_typeof(after->'mediaAsset') = 'object'
        then jsonb_set(after, '{mediaAsset}', (after->'mediaAsset') - 'publicToken' - 'publicUrl' - 'relativePath' - 'url' - 'workspaceId', false)
        else after
      end
    ) as row from public.audit_logs`,
  }),
  bot_channel_webhooks: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id,
      'external_message_id', external_message_id,
      'status', status,
      'payload_sha256', payload_sha256,
      'completed_at', completed_at,
      'processing_attempt', processing_attempt,
      'lease_token', lease_token,
      'lease_expires_at', lease_expires_at,
      'processing_result', processing_result,
      'last_error', last_error,
      'reply_state', reply_state,
      'reply_attempt_token', reply_attempt_token,
      'reply_attempted_at', reply_attempted_at,
      'reply_completed_at', reply_completed_at,
      'reply_result', reply_result,
      'quarantine_reason', quarantine_reason,
      'quarantined_at', quarantined_at,
      'conflict_count', conflict_count
    ) as row from public.bot_channel_webhooks`,
    expectedSql: `select jsonb_build_object(
      'id', id,
      'external_message_id', case when external_message_id is null then null else 'evt_' || encode(digest(external_message_id, 'sha256'), 'hex') end,
      'status', case when status = 'ignored' then 'ignored' when status = 'routed' then 'completed' when status = 'processing' then 'failed' when status in ('received', 'completed', 'failed') then status else 'failed' end,
      'payload_sha256', null,
      'completed_at', case when status in ('routed', 'completed', 'ignored') then received_at else null end,
      'processing_attempt', case when status = 'routed' then 1 else 0 end,
      'lease_token', null,
      'lease_expires_at', null,
      'processing_result', null,
      'last_error', null,
      'reply_state', case when status = 'ignored' then 'not_applicable' when status = 'routed' then 'uncertain' else 'not_requested' end,
      'reply_attempt_token', null,
      'reply_attempted_at', null,
      'reply_completed_at', case when status in ('routed', 'ignored') then received_at else null end,
      'reply_result', null,
      'quarantine_reason', null,
      'quarantined_at', null,
      'conflict_count', 0
    ) as row from public.bot_channel_webhooks`,
  }),
  bot_conversations: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_conversations",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_conversations",
  }),
  bot_document_sends: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id, 'metadata', metadata) as row from public.bot_document_sends",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null, 'metadata', metadata - 'asset' - 'attachedMediaAssetPublicUrl' - 'attachedMediaAssetUrl' - 'documentUrl') as row from public.bot_document_sends",
  }),
  bot_messages: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_messages",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_messages",
  }),
  bot_tool_calls: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_tool_calls",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_tool_calls",
  }),
  buyer_search_profiles: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'organization_id', organization_id, 'owner_user_id', owner_user_id,
      'expires_at', expires_at, 'intent_type', intent_type, 'sub_object_type', sub_object_type,
      'area_from_sqm', area_from_sqm, 'area_to_sqm', area_to_sqm,
      'rooms_from', rooms_from, 'rooms_to', rooms_to,
      'region', region, 'municipality', municipality, 'postal_code', postal_code,
      'radius_km', radius_km, 'year_built_from', year_built_from, 'year_built_to', year_built_to,
      'equipment', equipment, 'accessibility', accessibility,
      'target_yield_basis_points', target_yield_basis_points,
      'exclusion_criteria', exclusion_criteria, 'auto_match_enabled', auto_match_enabled,
      'status', status, 'version', version, 'broker_operations_managed', broker_operations_managed
    ) as row from public.buyer_search_profiles`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'organization_id', null, 'owner_user_id', null,
      'expires_at', null, 'intent_type', 'purchase', 'sub_object_type', null,
      'area_from_sqm', area_sqm::numeric(12,2), 'area_to_sqm', area_sqm::numeric(12,2),
      'rooms_from', rooms::numeric(5,1), 'rooms_to', rooms::numeric(5,1),
      'region', null, 'municipality', null, 'postal_code', null,
      'radius_km', null, 'year_built_from', null, 'year_built_to', null,
      'equipment', array[]::text[], 'accessibility', 'none',
      'target_yield_basis_points', null, 'exclusion_criteria', array[]::text[],
      'auto_match_enabled', false,
      'status', case lower(coalesce(matching_status, ''))
        when 'active' then 'active' when 'aktiv' then 'active' when 'open' then 'active'
        when 'paused' then 'paused' when 'expired' then 'expired'
        when 'archived' then 'archived' else 'draft' end,
      'version', 1, 'broker_operations_managed', false
    ) as row from public.buyer_search_profiles`,
  }),
  company_profiles: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'status', status, 'approved_by_user_id', approved_by_user_id, 'approved_at', approved_at) as row from public.company_profiles",
    expectedSql: `select jsonb_build_object(
      'id', id,
      'status', case when status in ('approved', 'locked') and (approved_by_user_id is null or approved_at is null or country_code not in ('AT', 'DE', 'IE') or btrim(legal_name) = '' or btrim(legal_form) = '' or btrim(business_address) = '' or btrim(public_email) = '' or jsonb_typeof(representatives) is distinct from 'array' or case when jsonb_typeof(representatives) = 'array' then jsonb_array_length(representatives) = 0 else true end or (country_code = 'IE' and (btrim(registration_number) = '' or btrim(registration_authority) = '' or btrim(registered_office_address) = ''))) then 'needs_review' else status end,
      'approved_by_user_id', case when status not in ('approved', 'locked') or (status in ('approved', 'locked') and (approved_by_user_id is null or approved_at is null or country_code not in ('AT', 'DE', 'IE') or btrim(legal_name) = '' or btrim(legal_form) = '' or btrim(business_address) = '' or btrim(public_email) = '' or jsonb_typeof(representatives) is distinct from 'array' or case when jsonb_typeof(representatives) = 'array' then jsonb_array_length(representatives) = 0 else true end or (country_code = 'IE' and (btrim(registration_number) = '' or btrim(registration_authority) = '' or btrim(registered_office_address) = '')))) then null else approved_by_user_id end,
      'approved_at', case when status not in ('approved', 'locked') or (status in ('approved', 'locked') and (approved_by_user_id is null or approved_at is null or country_code not in ('AT', 'DE', 'IE') or btrim(legal_name) = '' or btrim(legal_form) = '' or btrim(business_address) = '' or btrim(public_email) = '' or jsonb_typeof(representatives) is distinct from 'array' or case when jsonb_typeof(representatives) = 'array' then jsonb_array_length(representatives) = 0 else true end or (country_code = 'IE' and (btrim(registration_number) = '' or btrim(registration_authority) = '' or btrim(registered_office_address) = '')))) then null else approved_at end
    ) as row from public.company_profiles`,
  }),
  contact_timeline_items: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'webhook_event_id', webhook_event_id, 'activity_type', activity_type,
      'lead_id', lead_id, 'property_id', property_id, 'unit_id', unit_id, 'deal_id', deal_id,
      'reservation_id', reservation_id, 'offer_id', offer_id, 'viewing_id', viewing_id,
      'closing_id', closing_id, 'owner_user_id', owner_user_id, 'version', version,
      'broker_operations_managed', broker_operations_managed
    ) as row from public.contact_timeline_items`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'webhook_event_id', null, 'activity_type', 'note',
      'lead_id', null, 'property_id', null, 'unit_id', null, 'deal_id', null,
      'reservation_id', null, 'offer_id', null, 'viewing_id', null,
      'closing_id', null, 'owner_user_id', null, 'version', 1,
      'broker_operations_managed', false
    ) as row from public.contact_timeline_items`,
  }),
  crm_bulk_runtime_batches: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'actor_user_id', actor_user_id, 'idempotency_key', idempotency_key,
      'request_sha256', request_sha256, 'status', status, 'selection_ids', selection_ids,
      'payload', payload, 'completed_at', completed_at, 'error', error
    ) as row from public.crm_bulk_runtime_batches`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'actor_user_id', null, 'idempotency_key', null,
      'request_sha256', null, 'status', 'completed', 'selection_ids', '[]'::jsonb,
      'payload', '{}'::jsonb, 'completed_at', null, 'error', null
    ) as row from public.crm_bulk_runtime_batches`,
  }),
  form_submissions: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'idempotency_key', idempotency_key, 'request_hash', request_hash, 'response_payload', response_payload, 'claim_lease_version', claim_lease_version) as row from public.form_submissions",
    expectedSql: "select jsonb_build_object('id', id, 'idempotency_key', null, 'request_hash', null, 'response_payload', null, 'claim_lease_version', null) as row from public.form_submissions",
  }),
  funnel_submissions: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'idempotency_key', idempotency_key) as row from public.funnel_submissions",
    expectedSql: "select jsonb_build_object('id', id, 'idempotency_key', null) as row from public.funnel_submissions",
  }),
  media_assets: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'url', url, 'public_token', public_token,
      'deletion_state', deletion_state, 'deletion_requested_at', deletion_requested_at,
      'deletion_requested_by_user_id', deletion_requested_by_user_id,
      'created_by_user_id', created_by_user_id
    ) as row from public.media_assets`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'url', '/api/media/files/' || id::text, 'public_token', null,
      'deletion_state', 'active', 'deletion_requested_at', null,
      'deletion_requested_by_user_id', null, 'created_by_user_id', null
    ) as row from public.media_assets`,
  }),
  property_channels: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'runtime_key', runtime_key) as row from public.property_channels",
    expectedSql: "select jsonb_build_object('id', id, 'runtime_key', null) as row from public.property_channels",
  }),
  property_export_jobs: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'operation', operation, 'provider_key', provider_key,
      'payload_snapshot', payload_snapshot, 'payload_sha256', payload_sha256,
      'snapshot_captured_at', snapshot_captured_at, 'artifact_payload', artifact_payload,
      'artifact_sha256', artifact_sha256, 'artifact_content_type', artifact_content_type,
      'artifact_filename', artifact_filename, 'provider_request_id', provider_request_id,
      'provider_acknowledged_at', provider_acknowledged_at, 'result_metadata', result_metadata
    ) as row from public.property_export_jobs`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'operation', null, 'provider_key', null,
      'payload_snapshot', null, 'payload_sha256', null, 'snapshot_captured_at', null,
      'artifact_payload', null, 'artifact_sha256', null, 'artifact_content_type', null,
      'artifact_filename', null, 'provider_request_id', null,
      'provider_acknowledged_at', null, 'result_metadata', '{}'::jsonb
    ) as row from public.property_export_jobs`,
  }),
  property_viewing_slots: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'target_kind', target_kind, 'property_id', property_id, 'timezone', timezone,
      'address_mode', address_mode, 'address_text', address_text, 'personal_note', personal_note,
      'internal_note', internal_note, 'invitation_status', invitation_status,
      'reminder_at', reminder_at, 'cancellation_reason', cancellation_reason,
      'calendar_event_id', calendar_event_id, 'version', version,
      'broker_operations_managed', broker_operations_managed
    ) as row from public.property_viewing_slots`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'target_kind', 'unit', 'property_id', null, 'timezone', 'Europe/Vienna',
      'address_mode', 'property', 'address_text', '', 'personal_note', '',
      'internal_note', '', 'invitation_status', 'not_requested',
      'reminder_at', null, 'cancellation_reason', null, 'calendar_event_id', null,
      'version', 1, 'broker_operations_managed', false
    ) as row from public.property_viewing_slots`,
  }),
  public_submission_idempotency: Object.freeze({
    actualSql: "select jsonb_build_object('idempotency_hash', idempotency_hash, 'lease_version', lease_version) as row from public.public_submission_idempotency",
    expectedSql: "select jsonb_build_object('idempotency_hash', idempotency_hash, 'lease_version', 1) as row from public.public_submission_idempotency",
  }),
  seller_listings: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'metadata', metadata) as row from public.seller_listings",
    expectedSql: "select jsonb_build_object('id', id, 'metadata', '{}'::jsonb) as row from public.seller_listings",
  }),
  tasks: Object.freeze({
    actualSql: `select jsonb_build_object(
      'id', id, 'broker_activity_id', broker_activity_id, 'property_id', property_id,
      'unit_id', unit_id, 'deal_id', deal_id, 'reservation_id', reservation_id,
      'offer_id', offer_id, 'viewing_id', viewing_id, 'closing_id', closing_id
    ) as row from public.tasks`,
    expectedSql: `select jsonb_build_object(
      'id', id, 'broker_activity_id', null, 'property_id', null,
      'unit_id', null, 'deal_id', null, 'reservation_id', null,
      'offer_id', null, 'viewing_id', null, 'closing_id', null
    ) as row from public.tasks`,
  }),
  workspaces: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'is_qa', is_qa) as row from public.workspaces",
    expectedSql: "select jsonb_build_object('id', id, 'is_qa', false) as row from public.workspaces",
  }),
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

const intentionalUnvalidatedConstraintSql = intentionalUnvalidatedRecoveryConstraints
  .map(({ constraintName, tableName }) => `('${tableName}', '${constraintName}')`)
  .join(",\n        ");

const targetMigrationOrderSql = recoveryMigrationPlan
  .map((version, index) => `('${version}', ${index + 1})`)
  .join(",\n        ");

export const recoveryDatabaseQueryPack = Object.freeze({
  assertionQueries: Object.freeze({
    catalogSql: `with intentional_constraint(table_name, constraint_name) as (
      values
        ${intentionalUnvalidatedConstraintSql}
    ), tenant_role as (
      select * from pg_catalog.pg_roles where rolname = 'novalure_tenant_app'
    ), application_role as (
      select * from pg_catalog.pg_roles where rolname = 'novalure_app'
    ), trusted_owner as (
      select role_row.oid
      from pg_catalog.pg_roles role_row
      where role_row.rolname = 'pg_database_owner'
      union
      select database_row.datdba
      from pg_catalog.pg_database database_row
      where database_row.datname = pg_catalog.current_database()
    ), pilot_privilege_expectation(table_name, privilege_type) as (
      values
        ('projects', 'SELECT'),
        ('projects', 'IN' || 'SERT'),
        ('projects', 'UP' || 'DATE'),
        ('projects', 'DE' || 'LETE'),
        ('contacts', 'SELECT'),
        ('contacts', 'IN' || 'SERT'),
        ('contacts', 'UP' || 'DATE'),
        ('contacts', 'DE' || 'LETE'),
        ('leads', 'SELECT'),
        ('leads', 'IN' || 'SERT'),
        ('leads', 'UP' || 'DATE'),
        ('leads', 'DE' || 'LETE'),
        ('deals', 'SELECT'),
        ('deals', 'IN' || 'SERT'),
        ('deals', 'UP' || 'DATE'),
        ('deals', 'DE' || 'LETE'),
        ('audit_logs', 'SELECT'),
        ('audit_logs', 'IN' || 'SERT')
    ), policy_expectation(table_oid, policy_name, command, using_predicate, check_predicate) as (
      values
        (
          'public.projects'::regclass,
          'projects_tenant_actor_policy',
          '*',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g'),
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g')
        ),
        (
          'public.contacts'::regclass,
          'contacts_tenant_actor_policy',
          '*',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g'),
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g')
        ),
        (
          'public.leads'::regclass,
          'leads_tenant_actor_policy',
          '*',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g'),
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g')
        ),
        (
          'public.deals'::regclass,
          'deals_tenant_actor_policy',
          '*',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g'),
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g')
        ),
        (
          'public.audit_logs'::regclass,
          'audit_logs_tenant_select_policy',
          'r',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and nullif(current_setting('app.actor_id', true), '')::uuid is not null$predicate$), '(::text)|[()[:space:]]', '', 'g'),
          ''
        ),
        (
          'public.audit_logs'::regclass,
          'audit_logs_tenant_insert_policy',
          'a',
          '',
          regexp_replace(lower($predicate$workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid$predicate$), '(::text)|[()[:space:]]', '', 'g')
        )
    ) select
      to_regclass('public.bot_channel_webhooks_workspace_message_uidx') is not null as legacy_webhook_index_present,
      to_regclass('public.bot_channel_webhooks_account_event_uidx') is not null as provider_webhook_index_present,
      exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = 'public.company_profiles'::regclass
          and conname = 'company_profiles_approval_integrity_check'
      ) as company_approval_constraint_present,
      coalesce((
        select convalidated from pg_catalog.pg_constraint
        where conrelid = 'public.company_profiles'::regclass
          and conname = 'company_profiles_approval_integrity_check'
      ), false) as company_approval_constraint_validated,
      exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = 'public.media_assets'::regclass
          and conname = 'media_assets_deletion_state_check'
      ) as media_deletion_constraint_present,
      coalesce((
        select convalidated from pg_catalog.pg_constraint
        where conrelid = 'public.media_assets'::regclass
          and conname = 'media_assets_deletion_state_check'
      ), false) as media_deletion_constraint_validated,
      to_regclass('public.novalure_schema_migration_checksums') is not null as migration_checksum_projection_present,
      to_regclass('public.public_funnel_visit_events') is not null as public_funnel_visit_events_present,
      not exists (
        select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and (not c.relrowsecurity or not c.relforcerowsecurity)
      ) as pilot_rls_enabled,
      coalesce((
        select not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
          and not rolcreaterole and not rolreplication and not rolbypassrls
        from tenant_role
      ), false) as tenant_role_safe,
      coalesce((
        select shobj_description(oid, 'pg_authid')
          ~ '^novalure-tenant-cutover:[a-f0-9]{40}$'
        from tenant_role
      ), false) as tenant_role_attested,
      coalesce((
        select shobj_description(oid, 'pg_authid')
        from tenant_role
      ), '') as tenant_role_attestation,
      exists (
        select 1
        from pg_catalog.pg_auth_members membership
        join tenant_role on tenant_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
        where member_role.rolname = 'novalure_app'
          and member_role.rolcanlogin
          and member_role.rolinherit
          and not member_role.rolsuper
          and not member_role.rolcreatedb
          and not member_role.rolcreaterole
          and not member_role.rolreplication
          and not member_role.rolbypassrls
          and membership.inherit_option
          and not membership.set_option
          and not membership.admin_option
      ) as tenant_direct_login_member_present,
      (
        select count(*) = 1
        from pg_catalog.pg_auth_members membership
        join tenant_role on tenant_role.oid = membership.roleid
      ) and exists (
        select 1
        from pg_catalog.pg_auth_members membership
        join tenant_role on tenant_role.oid = membership.roleid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
        where member_role.rolname = 'novalure_app'
          and member_role.rolcanlogin
          and member_role.rolinherit
          and not member_role.rolsuper
          and not member_role.rolcreatedb
          and not member_role.rolcreaterole
          and not member_role.rolreplication
          and not member_role.rolbypassrls
          and membership.inherit_option
          and not membership.set_option
          and not membership.admin_option
      ) and not exists (
        select 1
        from pg_catalog.pg_auth_members membership
        cross join application_role
        cross join tenant_role
        where membership.roleid = application_role.oid
          or membership.member = tenant_role.oid
          or (
            membership.member = application_role.oid
            and membership.roleid <> tenant_role.oid
          )
      ) as tenant_membership_safe,
      not exists (
        select 1
        from pg_catalog.pg_database database_row
        cross join application_role
        cross join tenant_role
        where database_row.datname = pg_catalog.current_database()
          and database_row.datdba in (application_role.oid, tenant_role.oid)
      ) as tenant_database_owner_boundary_exact,
      not exists (
        select 1
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join tenant_role
        cross join application_role
        cross join lateral pg_catalog.aclexplode(
          coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) grant_entry
        where namespace.nspname = 'public'
          and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and (
            grant_entry.is_grantable
            or (
              grant_entry.grantee <> relation.relowner
              and case
                when grant_entry.grantee = tenant_role.oid then
                  (
                  relation.relname = 'audit_logs'
                  and grant_entry.privilege_type not in ('SELECT', 'IN' || 'SERT')
                  )
                  or (
                  relation.relname <> 'audit_logs'
                  and grant_entry.privilege_type not in (
                    'SELECT',
                    'IN' || 'SERT',
                    'UP' || 'DATE',
                    'DE' || 'LETE'
                  )
                  )
                else true
              end
            )
          )
      ) as pilot_application_table_acl_boundary_exact,
      not exists (
        select 1
        from pilot_privilege_expectation expected
        cross join tenant_role
        where not exists (
          select 1
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) grant_entry
          where namespace.nspname = 'public'
            and relation.relname = expected.table_name
            and grant_entry.grantee = tenant_role.oid
            and grant_entry.privilege_type = expected.privilege_type
            and not grant_entry.is_grantable
        )
      ) as pilot_tenant_table_privileges_exact,
      not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join tenant_role
        cross join application_role
        cross join lateral pg_catalog.aclexplode(attribute.attacl) grant_entry
        where namespace.nspname = 'public'
          and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and attribute.attnum > 0
          and not attribute.attisdropped
      ) as pilot_application_column_acl_boundary_exact,
      not exists (
        select 1
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join tenant_role
        cross join application_role
        where namespace.nspname = 'public'
          and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and relation.relowner not in (select oid from trusted_owner)
      ) as pilot_application_owner_boundary_exact,
      (
        not exists (
          select 1
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join application_role
          cross join tenant_role
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) grant_entry
          where namespace.nspname = 'public'
            and relation.relname in (
              'public_funnel_visit_events',
              'novalure_schema_migrations',
              'novalure_schema_migration_checksums'
            )
            and (
              grant_entry.is_grantable
              or (
                grant_entry.grantee <> relation.relowner
                and case
                  when relation.relname = 'public_funnel_visit_events' then not (
                    grant_entry.grantee = application_role.oid
                    and grant_entry.privilege_type in (
                      'SELECT',
                      'IN' || 'SERT',
                      'DE' || 'LETE'
                    )
                  )
                  when relation.relname = 'novalure_schema_migration_checksums' then not (
                    grant_entry.grantee = application_role.oid
                    and grant_entry.privilege_type = 'SELECT'
                  )
                  else true
                end
              )
            )
        )
        and not exists (
          select 1
          from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join lateral pg_catalog.aclexplode(attribute.attacl) grant_entry
          where namespace.nspname = 'public'
            and relation.relname in (
              'public_funnel_visit_events',
              'novalure_schema_migrations',
              'novalure_schema_migration_checksums'
            )
            and attribute.attnum > 0
            and not attribute.attisdropped
        )
        and not exists (
          select 1
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join application_role
          cross join tenant_role
          where namespace.nspname = 'public'
            and relation.relname in (
              'public_funnel_visit_events',
              'novalure_schema_migrations',
              'novalure_schema_migration_checksums'
            )
            and relation.relowner not in (select oid from trusted_owner)
        )
      ) as critical_release_object_acl_boundary_exact,
      not exists (
        select 1
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join tenant_role
        cross join application_role
        where namespace.nspname = 'public'
          and relation.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and relation.relowner not in (select oid from trusted_owner)
      ) as pilot_owners_safe,
      coalesce((
        select has_schema_privilege(oid, 'public', 'USAGE') from tenant_role
      ), false) as tenant_schema_usage,
      (
        exists (
          select 1
          from pg_catalog.pg_namespace namespace
          cross join tenant_role
          cross join lateral pg_catalog.aclexplode(
            coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
          ) grant_entry
          where namespace.nspname = 'public'
            and grant_entry.grantee = tenant_role.oid
            and grant_entry.privilege_type = 'USAGE'
            and not grant_entry.is_grantable
        )
        and not exists (
          select 1
          from pg_catalog.pg_namespace namespace
          cross join tenant_role
          cross join application_role
          cross join lateral pg_catalog.aclexplode(
            coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
          ) grant_entry
          where namespace.nspname = 'public'
            and grant_entry.grantee <> namespace.nspowner
            and (
              grant_entry.is_grantable
              or grant_entry.grantee not in (0, application_role.oid, tenant_role.oid)
              or grant_entry.privilege_type <> 'USAGE'
            )
        )
        and not exists (
          select 1
          from pg_catalog.pg_namespace namespace
          cross join tenant_role
          cross join application_role
          where namespace.nspname = 'public'
            and namespace.nspowner not in (select oid from trusted_owner)
        )
      ) as tenant_schema_acl_boundary_exact,
      (
        select count(*)
        from pg_catalog.pg_policy policy
        where policy.polrelid = any(array[
          'public.projects'::regclass,
          'public.contacts'::regclass,
          'public.leads'::regclass,
          'public.deals'::regclass,
          'public.audit_logs'::regclass
        ]::oid[])
      ) = 6 and not exists (
        select 1
        from policy_expectation expected
        left join pg_catalog.pg_policy policy
          on policy.polrelid = expected.table_oid
         and policy.polname = expected.policy_name
        where policy.oid is null
           or policy.polcmd <> expected.command
           or not policy.polpermissive
           or policy.polroles is distinct from array[(select oid from tenant_role)]::oid[]
           or regexp_replace(
                lower(coalesce(pg_get_expr(policy.polqual, policy.polrelid, false), '')),
                '(::text)|[()[:space:]]',
                '',
                'g'
              ) <> expected.using_predicate
           or regexp_replace(
                lower(coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid, false), '')),
                '(::text)|[()[:space:]]',
                '',
                'g'
              ) <> expected.check_predicate
      ) as pilot_policies_exact,
      (
        select count(*) = 1
        from pg_catalog.pg_trigger trigger_row
        where trigger_row.tgrelid = 'public.audit_logs'::regclass
          and trigger_row.tgname = 'audit_logs_append_only_guard'
          and not trigger_row.tgisinternal
          and trigger_row.tgenabled = 'O'
          and trigger_row.tgtype = 58
          and trigger_row.tgfoid = 'public.reject_audit_logs_mutation()'::regprocedure
      ) as audit_append_only_guard_exact,
      (
        select count(*) = 1
        from pg_catalog.pg_proc function_row
        join pg_catalog.pg_language function_language on function_language.oid = function_row.prolang
        where function_row.oid = 'public.reject_audit_logs_mutation()'::regprocedure
          and function_language.lanname = 'plpgsql'
          and function_row.prokind = 'f'
          and function_row.prorettype = 'pg_catalog.trigger'::regtype
          and function_row.pronargs = 0
          and not function_row.prosecdef
          and not function_row.proleakproof
          and function_row.provolatile = 'v'
          and function_row.proparallel = 'u'
          and function_row.proconfig = array['search_path=pg_catalog, public, pg_temp']::text[]
          and regexp_replace(lower(function_row.prosrc), '[[:space:]]', '', 'g')
            = regexp_replace(lower($function_body$
                begin
                  raise exception using
                    errcode = '55000',
                    message = 'audit_logs is append-only';
                end;
              $function_body$), '[[:space:]]', '', 'g')
      ) as audit_append_only_function_exact,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'constraintName', expected.constraint_name,
            'tableName', expected.table_name
          ) order by expected.table_name, expected.constraint_name
        )
        from intentional_constraint expected
        join pg_catalog.pg_constraint con
          on con.conrelid = expected.table_name::regclass
         and con.conname = expected.constraint_name
        where not con.convalidated
      ), '[]'::jsonb) as intentional_unvalidated_constraints,
      (
        select count(*)::integer
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public'
          and not con.convalidated
          and not exists (
            select 1
            from intentional_constraint expected
            where con.conrelid = expected.table_name::regclass
              and con.conname = expected.constraint_name
          )
      ) as unexpected_unvalidated_constraint_count`,
    companyProfileApprovalSql: `select
      exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = 'public.company_profiles'::regclass
          and conname = 'company_profiles_approval_integrity_check'
      ) as constraint_present,
      coalesce((
        select convalidated from pg_catalog.pg_constraint
        where conrelid = 'public.company_profiles'::regclass
          and conname = 'company_profiles_approval_integrity_check'
      ), false) as constraint_validated,
      count(*) filter (
        where status in ('approved', 'locked') and (
          approved_by_user_id is null or approved_at is null
          or country_code not in ('AT', 'DE', 'IE')
          or btrim(legal_name) = '' or btrim(legal_form) = ''
          or btrim(business_address) = '' or btrim(public_email) = ''
          or jsonb_typeof(representatives) is distinct from 'array'
          or case when jsonb_typeof(representatives) = 'array'
            then jsonb_array_length(representatives) = 0 else true end
          or (country_code = 'IE' and (
            btrim(registration_number) = '' or btrim(registration_authority) = ''
            or btrim(registered_office_address) = ''
          ))
        )
      )::integer as invalid_approved_count,
      count(*) filter (
        where status not in ('approved', 'locked')
          and (approved_by_user_id is not null or approved_at is not null)
      )::integer as stale_approval_metadata_count
      from public.company_profiles`,
    targetMigrationOrderSql: `with target(version, expected_ordinal) as (
      values
        ${targetMigrationOrderSql}
    ), matched as (
      select target.version, target.expected_ordinal, ledger.applied_at
      from target
      join public.novalure_schema_migrations ledger on ledger.version = target.version
    ), observed as (
      select
        version,
        expected_ordinal,
        applied_at,
        row_number() over (order by applied_at, version)::integer as observed_ordinal,
        lag(applied_at) over (order by applied_at, version) as previous_applied_at
      from matched
    ) select
      coalesce(array_agg(version order by applied_at, version), array[]::text[])
        as applied_versions,
      count(*)::integer as target_count,
      count(*) = ${recoveryMigrationPlan.length}
        and bool_and(expected_ordinal = observed_ordinal)
        and bool_and(previous_applied_at is null or applied_at > previous_applied_at)
        as strictly_increasing,
      count(*) = ${recoveryMigrationPlan.length}
        and (array_agg(version order by applied_at desc, version desc))[1]
          = '061_validate_and_activate_tenant_rls_pilot'
        and (max(applied_at) filter (where version <> '061_validate_and_activate_tenant_rls_pilot'))
          < (max(applied_at) filter (where version = '061_validate_and_activate_tenant_rls_pilot'))
        as rls_cutover_last
      from observed`,
  }),
  baselineMigrationPlan: recoveryBaselineMigrationPlan,
  catalogSql: `with objects as (
    select case when c.relkind = 'S' then 'sequence' else 'table' end::text as kind,
      n.nspname as schema, c.relname as name,
      c.oid::regclass::text as identity,
      concat_ws('|', c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity) as definition
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','S')
    union all
    select case when c.relkind = 'm' then 'materialized_view' else 'view' end,
      n.nspname, c.relname, c.oid::regclass::text,
      pg_catalog.pg_get_viewdef(c.oid, true) || '|reloptions=' || coalesce(array_to_string(c.reloptions, ','), '')
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v','m')
    union all
    select 'column', n.nspname, a.attname,
      c.oid::regclass::text || '.' || pg_catalog.quote_ident(a.attname),
      concat_ws('|',
        'attnum=' || a.attnum::text,
        'type=' || pg_catalog.format_type(a.atttypid, a.atttypmod),
        'notnull=' || a.attnotnull::text,
        'identity=' || a.attidentity::text,
        'generated=' || a.attgenerated::text,
        'collation=' || case when a.attcollation = 0 then '' else a.attcollation::regcollation::text end,
        'default=' || coalesce(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true), '')
      )
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','S')
      and a.attnum > 0 and not a.attisdropped
    union all
    select 'index', n.nspname, c.relname, c.oid::regclass::text, pg_catalog.pg_get_indexdef(c.oid)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'i'
    union all
    select 'constraint', n.nspname, con.conname, con.conrelid::regclass::text || ':' || con.conname,
      pg_catalog.pg_get_constraintdef(con.oid, true) || '|validated=' || con.convalidated::text
    from pg_catalog.pg_constraint con join pg_catalog.pg_namespace n on n.oid = con.connamespace
    where n.nspname = 'public'
    union all
    select 'policy', n.nspname, pol.polname, pol.polrelid::regclass::text || ':' || pol.polname,
      concat_ws(
        '|',
        'command=' || pol.polcmd,
        'permissive=' || pol.polpermissive::text,
        'roles=' || array_to_string(array(
          select case when role_oid = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(role_oid) end
          from unnest(pol.polroles) as policy_role(role_oid)
          order by case when role_oid = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(role_oid) end
        ), ','),
        'using=' || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid, false), ''),
        'check=' || coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid, false), '')
      )
    from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select 'trigger', n.nspname, trg.tgname,
      trg.tgrelid::regclass::text || ':' || trg.tgname,
      concat_ws(
        '|',
        pg_catalog.pg_get_triggerdef(trg.oid, true),
        'enabled=' || trg.tgenabled::text,
        'type=' || trg.tgtype::text,
        'function=' || trg.tgfoid::regprocedure::text
      )
    from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class c on c.oid = trg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not trg.tgisinternal
    union all
    select case when p.prokind = 'p' then 'procedure' else 'function' end,
      n.nspname, p.proname, p.oid::regprocedure::text,
      pg_catalog.pg_get_functiondef(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f','p')
  ) select kind, schema, name, identity, definition from objects order by kind, schema, identity`,
  grantSql: `select
      object_type,
      object_name,
      grantee,
      privilege,
      bool_or(grantable) as grantable
    from (
      select
        case
          when relation.relkind in ('v', 'm') then 'view'
          when relation.relkind = 'S' then 'sequence'
          else 'table'
        end::text as object_type,
        namespace.nspname || '.' || relation.relname as object_name,
        case
          when grant_entry.grantee = 0 then 'PUBLIC'
          else pg_catalog.pg_get_userbyid(grant_entry.grantee)
        end as grantee,
        grant_entry.privilege_type as privilege,
        grant_entry.is_grantable as grantable
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            (case when relation.relkind = 'S' then 's' else 'r' end)::"char",
            relation.relowner
          )
        )
      ) grant_entry
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      union all
      select
        'column',
        namespace.nspname || '.' || relation.relname || '.' || attribute.attname,
        case
          when grant_entry.grantee = 0 then 'PUBLIC'
          else pg_catalog.pg_get_userbyid(grant_entry.grantee)
        end,
        grant_entry.privilege_type,
        grant_entry.is_grantable
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) grant_entry
      where namespace.nspname = 'public'
        and attribute.attnum > 0
        and not attribute.attisdropped
      union all
      select
        'schema',
        namespace.nspname,
        case
          when grant_entry.grantee = 0 then 'PUBLIC'
          else pg_catalog.pg_get_userbyid(grant_entry.grantee)
        end,
        grant_entry.privilege_type,
        grant_entry.is_grantable
      from pg_catalog.pg_namespace namespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
      ) grant_entry
      where namespace.nspname = 'public'
      union all
      select
        'function',
        pg_catalog.format(
          '%I.%I(%s)',
          namespace.nspname,
          function_row.proname,
          pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        ),
        case
          when grant_entry.grantee = 0 then 'PUBLIC'
          else pg_catalog.pg_get_userbyid(grant_entry.grantee)
        end,
        grant_entry.privilege_type,
        grant_entry.is_grantable
      from pg_catalog.pg_proc function_row
      join pg_catalog.pg_namespace namespace on namespace.oid = function_row.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) grant_entry
      where namespace.nspname = 'public'
        and function_row.prokind in ('f', 'p')
    ) privileges
    group by object_type, object_name, grantee, privilege
    order by object_type, object_name, grantee, privilege`,
  identitySql: `select current_setting('neon.project_id', true) as project_id,
    current_setting('neon.branch_id', true) as branch_id,
    current_database() as database_name,
    current_user as role_name,
    current_setting('server_version_num')::integer as server_version_num,
    current_setting('transaction_isolation') as transaction_isolation,
    current_setting('transaction_read_only')::boolean as transaction_read_only`,
  ledgerSql: "select version, checksum from public.novalure_schema_migrations order by version",
  locksSql: `select
    count(*) filter (where state = 'idle in transaction')::integer as idle_in_transaction_count,
    count(*) filter (where wait_event_type = 'Lock' and wait_event = 'advisory')::integer as migration_advisory_lock_count,
    count(*) filter (where wait_event_type = 'Lock' and wait_event_type is not null)::integer as schema_blocking_lock_count,
    count(*) filter (where pid <> pg_backend_pid() and datname = current_database() and application_name !~ '^novalure-recovery-evidence')::integer as unexpected_target_session_count
    from pg_catalog.pg_stat_activity where datname = current_database()`,
  tableQueries: recoveryTableQuerySpecs,
  transformationQueries,
  version: recoveryQueryPackVersion,
});

export const recoveryQueryPackCanonicalJson = `${JSON.stringify(canonicalize(recoveryDatabaseQueryPack), null, 2)}\n`;
export const recoveryQueryPackSha256 = createHash("sha256")
  .update(recoveryQueryPackCanonicalJson)
  .digest("hex");
