-- Validate the tenant-qualified relationships introduced by migration 073.
-- This is deliberately separate from constraint creation so an audited
-- anti-join preflight can fail before PostgreSQL begins validation scans.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
declare
  relation record;
  violation_count bigint;
begin
  if not exists (
    select 1
    from public.novalure_schema_migrations
    where version = '073_launch_tenant_relation_guards'
  ) then
    raise exception 'migration 073_launch_tenant_relation_guards is required before 074';
  end if;

  for relation in
    select *
    from (values
      ('funnels', 'funnels_workspace_project_fk', 'project_id', 'projects'),
      ('funnels', 'funnels_workspace_owner_fk', 'owner_user_id', 'workspace_users'),
      ('funnel_steps', 'funnel_steps_workspace_project_fk', 'project_id', 'projects'),
      ('funnel_steps', 'funnel_steps_workspace_funnel_fk', 'funnel_id', 'funnels'),
      ('funnel_steps', 'funnel_steps_workspace_bot_fk', 'bot_rule_id', 'bots'),
      ('property_inquiries', 'property_inquiries_workspace_project_fk', 'project_id', 'projects'),
      ('property_inquiries', 'property_inquiries_workspace_property_fk', 'property_id', 'seller_listings'),
      ('property_inquiries', 'property_inquiries_workspace_unit_fk', 'unit_id', 'property_units'),
      ('property_inquiries', 'property_inquiries_workspace_contact_fk', 'contact_id', 'contacts'),
      ('property_inquiries', 'property_inquiries_workspace_lead_fk', 'lead_id', 'leads'),
      ('property_inquiries', 'property_inquiries_workspace_funnel_fk', 'funnel_id', 'funnels'),
      ('property_inquiries', 'property_inquiries_workspace_form_fk', 'form_id', 'forms'),
      ('property_inquiries', 'property_inquiries_workspace_owner_fk', 'owner_user_id', 'workspace_users'),
      ('property_activity_events', 'property_activity_events_workspace_project_fk', 'project_id', 'projects'),
      ('property_activity_events', 'property_activity_events_workspace_property_fk', 'property_id', 'seller_listings'),
      ('property_activity_events', 'property_activity_events_workspace_unit_fk', 'unit_id', 'property_units'),
      ('property_activity_events', 'property_activity_events_workspace_contact_fk', 'contact_id', 'contacts'),
      ('property_activity_events', 'property_activity_events_workspace_lead_fk', 'lead_id', 'leads'),
      ('property_activity_events', 'property_activity_events_workspace_actor_fk', 'actor_user_id', 'workspace_users')
    ) as definitions(child_table, constraint_name, child_column, parent_table)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid = ('public.' || relation.child_table)::regclass
        and constraint_row.conname = relation.constraint_name
    ) then
      raise exception 'required tenant constraint % is missing', relation.constraint_name;
    end if;

    execute format(
      'select count(*) from public.%I child '
      || 'left join public.%I parent '
      || 'on parent.workspace_id = child.workspace_id and parent.id = child.%I '
      || 'where child.%I is not null and parent.id is null',
      relation.child_table,
      relation.parent_table,
      relation.child_column,
      relation.child_column
    ) into violation_count;

    if violation_count <> 0 then
      raise exception 'tenant relation preflight failed for %: % violation(s)',
        relation.constraint_name,
        violation_count;
    end if;
  end loop;
end;
$migration$;

alter table public.funnels validate constraint funnels_workspace_project_fk;
alter table public.funnels validate constraint funnels_workspace_owner_fk;
alter table public.funnel_steps validate constraint funnel_steps_workspace_project_fk;
alter table public.funnel_steps validate constraint funnel_steps_workspace_funnel_fk;
alter table public.funnel_steps validate constraint funnel_steps_workspace_bot_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_project_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_property_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_unit_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_contact_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_lead_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_funnel_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_form_fk;
alter table public.property_inquiries validate constraint property_inquiries_workspace_owner_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_project_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_property_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_unit_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_contact_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_lead_fk;
alter table public.property_activity_events validate constraint property_activity_events_workspace_actor_fk;

do $migration$
declare
  validated_count integer;
begin
  select count(*)
  into validated_count
  from pg_catalog.pg_constraint
  where conname = any(array[
    'funnels_workspace_project_fk','funnels_workspace_owner_fk',
    'funnel_steps_workspace_project_fk','funnel_steps_workspace_funnel_fk','funnel_steps_workspace_bot_fk',
    'property_inquiries_workspace_project_fk','property_inquiries_workspace_property_fk',
    'property_inquiries_workspace_unit_fk','property_inquiries_workspace_contact_fk',
    'property_inquiries_workspace_lead_fk','property_inquiries_workspace_funnel_fk',
    'property_inquiries_workspace_form_fk','property_inquiries_workspace_owner_fk',
    'property_activity_events_workspace_project_fk','property_activity_events_workspace_property_fk',
    'property_activity_events_workspace_unit_fk','property_activity_events_workspace_contact_fk',
    'property_activity_events_workspace_lead_fk','property_activity_events_workspace_actor_fk'
  ]::text[])
    and convalidated;

  if validated_count <> 19 then
    raise exception 'expected 19 validated launch tenant constraints, found %', validated_count;
  end if;
end;
$migration$;
