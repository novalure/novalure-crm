import { createHash } from "node:crypto";

export const recoveryQueryPackVersion = 1;
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
  audit_logs: "to_jsonb(t) - 'webhook_event_id'",
  bot_conversations: "to_jsonb(t) - 'webhook_event_id'",
  bot_document_sends: "to_jsonb(t) - 'webhook_event_id'",
  bot_messages: "to_jsonb(t) - 'webhook_event_id'",
  bot_tool_calls: "to_jsonb(t) - 'webhook_event_id'",
  contact_timeline_items: "to_jsonb(t) - 'webhook_event_id'",
  form_submissions: "to_jsonb(t) - array['idempotency_key', 'request_hash', 'response_payload', 'claim_lease_version']",
  funnel_submissions: "to_jsonb(t) - 'idempotency_key'",
  public_submission_idempotency: "to_jsonb(t) - 'lease_version'",
  workspaces: "to_jsonb(t) - 'is_qa'",
});

const createdTables = new Set([
  "bot_channel_webhook_envelopes",
  "property_building_idempotency",
  "property_unit_idempotency",
  "public_funnel_visit_events",
  "qa_batch_objects",
  "qa_batches",
  "qa_reset_audit_events",
]);

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
  "bot_channel_webhook_envelopes",
  "bot_channel_webhooks",
  "bot_conversations",
  "bot_document_sends",
  "bot_messages",
  "bot_tool_calls",
  "bots",
  "company_profiles",
  "contact_timeline_items",
  "contacts",
  "deals",
  "form_submissions",
  "forms",
  "funnel_steps",
  "funnel_submissions",
  "funnels",
  "leads",
  "organizations",
  "projects",
  "property_activity_events",
  "property_buildings",
  "property_building_idempotency",
  "property_inquiries",
  "property_unit_idempotency",
  "property_units",
  "public_funnel_visit_events",
  "public_submission_idempotency",
  "qa_batch_objects",
  "qa_batches",
  "qa_reset_audit_events",
  "seller_listings",
  "tasks",
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
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.audit_logs",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.audit_logs",
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
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_document_sends",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_document_sends",
  }),
  bot_messages: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_messages",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_messages",
  }),
  bot_tool_calls: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.bot_tool_calls",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.bot_tool_calls",
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
    actualSql: "select jsonb_build_object('id', id, 'webhook_event_id', webhook_event_id) as row from public.contact_timeline_items",
    expectedSql: "select jsonb_build_object('id', id, 'webhook_event_id', null) as row from public.contact_timeline_items",
  }),
  form_submissions: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'idempotency_key', idempotency_key, 'request_hash', request_hash, 'response_payload', response_payload, 'claim_lease_version', claim_lease_version) as row from public.form_submissions",
    expectedSql: "select jsonb_build_object('id', id, 'idempotency_key', null, 'request_hash', null, 'response_payload', null, 'claim_lease_version', null) as row from public.form_submissions",
  }),
  funnel_submissions: Object.freeze({
    actualSql: "select jsonb_build_object('id', id, 'idempotency_key', idempotency_key) as row from public.funnel_submissions",
    expectedSql: "select jsonb_build_object('id', id, 'idempotency_key', null) as row from public.funnel_submissions",
  }),
  public_submission_idempotency: Object.freeze({
    actualSql: "select jsonb_build_object('idempotency_hash', idempotency_hash, 'lease_version', lease_version) as row from public.public_submission_idempotency",
    expectedSql: "select jsonb_build_object('idempotency_hash', idempotency_hash, 'lease_version', 1) as row from public.public_submission_idempotency",
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

export const recoveryDatabaseQueryPack = Object.freeze({
  assertionQueries: Object.freeze({
    catalogSql: `select
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
      to_regclass('public.novalure_schema_migration_checksums') is not null as migration_checksum_projection_present,
      to_regclass('public.public_funnel_visit_events') is not null as public_funnel_visit_events_present,
      exists (
        select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('projects', 'contacts', 'leads', 'deals', 'audit_logs')
          and (c.relrowsecurity or c.relforcerowsecurity)
      ) as pilot_rls_enabled,
      coalesce((
        select array_agg(con.conname::text order by con.conname::text)
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public' and not con.convalidated
          and con.conname::text = any(array[
            'audit_logs_workspace_actor_fk',
            'contacts_workspace_archived_by_fk',
            'contacts_workspace_organization_fk',
            'contacts_workspace_owner_fk',
            'contacts_workspace_project_fk',
            'deals_workspace_contact_fk',
            'deals_workspace_lead_fk',
            'deals_workspace_organization_fk',
            'deals_workspace_owner_fk',
            'deals_workspace_project_fk',
            'leads_workspace_assignee_fk',
            'leads_workspace_contact_fk',
            'leads_workspace_project_fk'
          ]::text[])
      ), array[]::text[]) as intentional_unvalidated_constraints,
      (
        select count(*)::integer
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public' and not con.convalidated
          and not (con.conname::text = any(array[
            'audit_logs_workspace_actor_fk',
            'contacts_workspace_archived_by_fk',
            'contacts_workspace_organization_fk',
            'contacts_workspace_owner_fk',
            'contacts_workspace_project_fk',
            'deals_workspace_contact_fk',
            'deals_workspace_lead_fk',
            'deals_workspace_organization_fk',
            'deals_workspace_owner_fk',
            'deals_workspace_project_fk',
            'leads_workspace_assignee_fk',
            'leads_workspace_contact_fk',
            'leads_workspace_project_fk'
          ]::text[]))
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
      concat_ws('|', pol.polcmd, pol.polpermissive, pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid))
    from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select 'trigger', n.nspname, trg.tgname,
      trg.tgrelid::regclass::text || ':' || trg.tgname,
      pg_catalog.pg_get_triggerdef(trg.oid, true) || '|enabled=' || trg.tgenabled::text
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
  grantSql: `select object_type, object_name, grantee, privilege_type as privilege, is_grantable = 'YES' as grantable
    from (
      select 'table'::text as object_type, table_schema || '.' || table_name as object_name, grantee, privilege_type, is_grantable
      from information_schema.role_table_grants where table_schema = 'public'
      union all
      select 'column', table_schema || '.' || table_name || '.' || column_name, grantee, privilege_type, is_grantable
      from information_schema.role_column_grants where table_schema = 'public'
      union all
      select 'function', routine_schema || '.' || routine_name, grantee, privilege_type, is_grantable
      from information_schema.role_routine_grants where routine_schema = 'public'
    ) grants order by object_type, object_name, grantee, privilege`,
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
