-- QA/PREVIEW-ONLY rollback companion for 081_broker_operations.sql.
--
-- This script refuses to run unless both session flags are explicitly set:
--   SET novalure.environment = 'preview';
--   SET novalure.allow_qa_schema_rollback = 'true';
-- It also refuses to delete operational data. Clean the isolated QA tenant via
-- an audited reset first, then rerun this script in one transaction.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- Data guards must see every tenant row even when FORCE RLS is active.
set local row_security = off;

do $rollback_guard$
declare
  populated_table text;
begin
  if current_setting('novalure.environment', true) is distinct from 'preview'
    or current_setting('novalure.allow_qa_schema_rollback', true) is distinct from 'true' then
    raise exception '081 rollback is restricted to an explicitly authorized Preview session';
  end if;

  select table_name into populated_table
  from (values
    ('broker_operation_requests'),
    ('buyer_match_evaluations'),
    ('buyer_match_decisions'),
    ('broker_offers'),
    ('broker_offer_items'),
    ('broker_offer_versions'),
    ('broker_offer_deliveries'),
    ('broker_viewing_history'),
    ('broker_closings'),
    ('broker_closing_participants'),
    ('broker_commission_splits')
  ) as candidate(table_name)
  where case candidate.table_name
    when 'broker_operation_requests' then exists (select 1 from public.broker_operation_requests)
    when 'buyer_match_evaluations' then exists (select 1 from public.buyer_match_evaluations)
    when 'buyer_match_decisions' then exists (select 1 from public.buyer_match_decisions)
    when 'broker_offers' then exists (select 1 from public.broker_offers)
    when 'broker_offer_items' then exists (select 1 from public.broker_offer_items)
    when 'broker_offer_versions' then exists (select 1 from public.broker_offer_versions)
    when 'broker_offer_deliveries' then exists (select 1 from public.broker_offer_deliveries)
    when 'broker_viewing_history' then exists (select 1 from public.broker_viewing_history)
    when 'broker_closings' then exists (select 1 from public.broker_closings)
    when 'broker_closing_participants' then exists (select 1 from public.broker_closing_participants)
    when 'broker_commission_splits' then exists (select 1 from public.broker_commission_splits)
  end
  limit 1;

  if populated_table is not null then
    raise exception '081 rollback refused: table % still contains operational data', populated_table;
  end if;

  if exists (
    select 1 from public.buyer_search_profiles
    where broker_operations_managed
      or organization_id is not null
      or owner_user_id is not null
      or expires_at is not null
      or intent_type <> 'purchase'
      or sub_object_type is not null
      or area_from_sqm is distinct from area_sqm
      or area_to_sqm is distinct from area_sqm
      or rooms_from is distinct from rooms
      or rooms_to is distinct from rooms
      or region is not null
      or municipality is not null
      or postal_code is not null
      or radius_km is not null
      or year_built_from is not null
      or year_built_to is not null
      or equipment <> '{}'
      or accessibility <> 'none'
      or target_yield_basis_points is not null
      or exclusion_criteria <> '{}'
      or auto_match_enabled
      or version <> 1
  ) then
    raise exception '081 rollback refused: buyer_search_profiles contains Broker Operations data';
  end if;

  if exists (
    select 1 from public.property_viewing_slots
    where broker_operations_managed
      or timezone <> 'Europe/Vienna'
      or target_kind <> 'unit'
      or property_id is not null
      or address_mode <> 'property'
      or address_text <> ''
      or personal_note <> ''
      or internal_note <> ''
      or invitation_status <> 'not_requested'
      or reminder_at is not null
      or cancellation_reason is not null
      or calendar_event_id is not null
      or version <> 1
  ) then
    raise exception '081 rollback refused: property_viewing_slots contains Broker Operations data';
  end if;

  if exists (
    select 1 from public.contact_timeline_items
    where broker_operations_managed
      or activity_type <> 'note'
      or lead_id is not null
      or property_id is not null
      or unit_id is not null
      or deal_id is not null
      or reservation_id is not null
      or offer_id is not null
      or viewing_id is not null
      or closing_id is not null
      or owner_user_id is not null
      or version <> 1
  ) then
    raise exception '081 rollback refused: contact_timeline_items contains Broker Operations data';
  end if;

  if exists (
    select 1 from public.tasks
    where broker_activity_id is not null
      or property_id is not null
      or unit_id is not null
      or deal_id is not null
      or reservation_id is not null
      or offer_id is not null
      or viewing_id is not null
      or closing_id is not null
  ) then
    raise exception '081 rollback refused: tasks contains Broker Operations relations';
  end if;
end;
$rollback_guard$;

alter table public.tasks
  drop constraint if exists tasks_broker_activity_fk,
  drop constraint if exists tasks_broker_property_fk,
  drop constraint if exists tasks_broker_unit_fk,
  drop constraint if exists tasks_broker_deal_fk,
  drop constraint if exists tasks_broker_reservation_fk,
  drop constraint if exists tasks_broker_offer_fk,
  drop constraint if exists tasks_broker_viewing_fk,
  drop constraint if exists tasks_broker_closing_fk,
  drop column if exists broker_activity_id,
  drop column if exists property_id,
  drop column if exists unit_id,
  drop column if exists deal_id,
  drop column if exists reservation_id,
  drop column if exists offer_id,
  drop column if exists viewing_id,
  drop column if exists closing_id;

alter table public.contact_timeline_items
  drop constraint if exists contact_timeline_items_broker_activity_type_check,
  drop constraint if exists contact_timeline_items_broker_version_check,
  drop constraint if exists contact_timeline_items_broker_offer_fk,
  drop constraint if exists contact_timeline_items_broker_viewing_fk,
  drop constraint if exists contact_timeline_items_broker_closing_fk,
  drop constraint if exists contact_timeline_items_broker_project_fk,
  drop constraint if exists contact_timeline_items_broker_contact_fk,
  drop constraint if exists contact_timeline_items_broker_lead_fk,
  drop constraint if exists contact_timeline_items_broker_property_fk,
  drop constraint if exists contact_timeline_items_broker_unit_fk,
  drop constraint if exists contact_timeline_items_broker_deal_fk,
  drop constraint if exists contact_timeline_items_broker_reservation_fk,
  drop constraint if exists contact_timeline_items_broker_owner_fk,
  drop column if exists activity_type,
  drop column if exists lead_id,
  drop column if exists property_id,
  drop column if exists unit_id,
  drop column if exists deal_id,
  drop column if exists reservation_id,
  drop column if exists offer_id,
  drop column if exists viewing_id,
  drop column if exists closing_id,
  drop column if exists owner_user_id,
  drop column if exists version,
  drop column if exists broker_operations_managed;

alter table public.property_viewing_slots
  drop constraint if exists property_viewing_slots_broker_address_mode_check,
  drop constraint if exists property_viewing_slots_broker_target_check,
  drop constraint if exists property_viewing_slots_broker_invitation_status_check,
  drop constraint if exists property_viewing_slots_broker_version_check,
  drop constraint if exists property_viewing_slots_broker_calendar_fk,
  drop constraint if exists property_viewing_slots_broker_project_fk,
  drop constraint if exists property_viewing_slots_broker_property_fk,
  drop constraint if exists property_viewing_slots_broker_unit_fk,
  drop constraint if exists property_viewing_slots_broker_contact_fk,
  drop constraint if exists property_viewing_slots_broker_lead_fk,
  drop constraint if exists property_viewing_slots_broker_deal_fk,
  drop constraint if exists property_viewing_slots_broker_owner_fk,
  drop column if exists target_kind,
  drop column if exists property_id,
  drop column if exists timezone,
  drop column if exists address_mode,
  drop column if exists address_text,
  drop column if exists personal_note,
  drop column if exists internal_note,
  drop column if exists invitation_status,
  drop column if exists reminder_at,
  drop column if exists cancellation_reason,
  drop column if exists calendar_event_id,
  drop column if exists version,
  drop column if exists broker_operations_managed;

alter table public.property_viewing_slots alter column unit_id set not null;

drop table if exists public.broker_commission_splits;
drop table if exists public.broker_closing_participants;
drop table if exists public.broker_closings;
drop table if exists public.broker_viewing_history;
drop table if exists public.broker_offer_deliveries;
drop table if exists public.broker_offer_versions;
drop table if exists public.broker_offer_items;
drop table if exists public.broker_offers;
drop table if exists public.buyer_match_decisions;
drop table if exists public.buyer_match_evaluations;
drop table if exists public.broker_operation_requests;

alter table public.buyer_search_profiles
  drop constraint if exists buyer_search_profiles_broker_status_check,
  drop constraint if exists buyer_search_profiles_intent_type_check,
  drop constraint if exists buyer_search_profiles_accessibility_check,
  drop constraint if exists buyer_search_profiles_ranges_check,
  drop constraint if exists buyer_search_profiles_broker_project_fk,
  drop constraint if exists buyer_search_profiles_broker_contact_fk,
  drop constraint if exists buyer_search_profiles_broker_organization_fk,
  drop constraint if exists buyer_search_profiles_broker_owner_fk,
  drop constraint if exists buyer_search_profiles_broker_lead_fk,
  drop column if exists organization_id,
  drop column if exists owner_user_id,
  drop column if exists expires_at,
  drop column if exists intent_type,
  drop column if exists sub_object_type,
  drop column if exists area_from_sqm,
  drop column if exists area_to_sqm,
  drop column if exists rooms_from,
  drop column if exists rooms_to,
  drop column if exists region,
  drop column if exists municipality,
  drop column if exists postal_code,
  drop column if exists radius_km,
  drop column if exists year_built_from,
  drop column if exists year_built_to,
  drop column if exists equipment,
  drop column if exists accessibility,
  drop column if exists target_yield_basis_points,
  drop column if exists exclusion_criteria,
  drop column if exists auto_match_enabled,
  drop column if exists status,
  drop column if exists version,
  drop column if exists broker_operations_managed;

drop index if exists public.contact_timeline_items_broker_scope_idx;
drop index if exists public.tasks_broker_activity_idx;
drop index if exists public.buyer_search_profiles_broker_scope_idx;
drop index if exists public.buyer_search_profiles_broker_owner_idx;
drop index if exists public.broker_ops_viewings_workspace_id_uidx;
drop index if exists public.broker_ops_profiles_workspace_id_uidx;
drop index if exists public.broker_ops_reservations_workspace_id_uidx;
drop index if exists public.broker_ops_property_media_workspace_id_uidx;
drop index if exists public.broker_ops_property_documents_workspace_id_uidx;
drop index if exists public.broker_ops_units_workspace_id_uidx;
drop index if exists public.broker_ops_listings_workspace_id_uidx;
drop index if exists public.broker_ops_calendar_events_workspace_id_uidx;
drop index if exists public.broker_ops_timeline_workspace_id_uidx;
drop index if exists public.broker_ops_tasks_workspace_id_uidx;
drop index if exists public.broker_ops_deals_workspace_id_uidx;
drop index if exists public.broker_ops_leads_workspace_id_uidx;
drop index if exists public.broker_ops_contacts_workspace_id_uidx;
drop index if exists public.broker_ops_organizations_workspace_id_uidx;
drop index if exists public.broker_ops_workspace_users_workspace_id_uidx;
drop index if exists public.broker_ops_projects_workspace_id_uidx;

do $rollback_ledger$
begin
  if to_regclass('public.novalure_schema_migrations') is not null then
    execute 'delete from public.novalure_schema_migrations where version = $1'
      using '081_broker_operations';
  end if;
end;
$rollback_ledger$;

commit;
