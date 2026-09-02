export const recoveryMigrationPlanContract =
  "FULL_PRODUCTION_CHAIN_057_084_RLS_LAST_V2";

export const recoveryMigrationPlan = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
  "068_qa_batch_reset_safety",
  "069_property_unit_idempotency",
  "070_funnel_submission_idempotency_recovery",
  "071_forms_owner_tenant_guard",
  "072_form_submission_atomicity",
  "073_launch_tenant_relation_guards",
  "074_validate_launch_tenant_relation_guards",
  "075_public_funnel_visit_truth",
  "076_bot_webhook_durable_processing",
  "077_schema_ledger_runtime_projection",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
  "080_property_export_runtime",
  "081_broker_operations",
  "082_content_library_privacy",
  "083_list_productivity_controls",
  "084_media_deletion_lifecycle",
  "061_validate_and_activate_tenant_rls_pilot",
]);

export const recoveryManualCutoverMigrations = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
  "068_qa_batch_reset_safety",
  "074_validate_launch_tenant_relation_guards",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
  "080_property_export_runtime",
  "081_broker_operations",
  "082_content_library_privacy",
  "083_list_productivity_controls",
  "084_media_deletion_lifecycle",
]);

// Immutable schema-v1 contract used only to verify the checked-in August drill.
// It must never be promoted to current release evidence.
export const historicalRecoveryMigrationPlanV1 = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "060_tenant_rls_pilot_prepare",
  "068_qa_batch_reset_safety",
  "069_property_unit_idempotency",
  "070_funnel_submission_idempotency_recovery",
  "071_forms_owner_tenant_guard",
  "072_form_submission_atomicity",
  "073_launch_tenant_relation_guards",
  "074_validate_launch_tenant_relation_guards",
  "075_public_funnel_visit_truth",
  "076_bot_webhook_durable_processing",
  "077_schema_ledger_runtime_projection",
  "078_company_profile_approval_integrity",
  "079_public_funnel_visit_role_boundary",
]);

export const historicalExcludedRecoveryMigrationsV1 = Object.freeze([
  "061_validate_and_activate_tenant_rls_pilot",
  "062_private_media_contract_cutover",
  "065_notification_guard_search_path_hardening",
]);
