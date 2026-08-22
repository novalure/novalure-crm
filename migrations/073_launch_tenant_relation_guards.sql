-- Enforce tenant-qualified relationships for Funnel authoring and Property
-- inquiry/activity writes. Historical rows are deliberately not repaired or
-- validated here: NOT VALID enforces every new or changed relation while a
-- separate, audited preflight can resolve legacy drift before VALIDATE.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.form_submissions'::regclass
      and conname = 'form_submissions_workspace_form_fk'
  ) then
    raise exception 'migration 072_form_submission_atomicity is required before 073';
  end if;
end;
$migration$;

-- UUID primary keys already make these pairs unique. The additional indexes
-- are therefore data-compatible and exist only as composite-FK targets.
create unique index if not exists bots_workspace_id_id_uidx
  on public.bots(workspace_id, id);
create unique index if not exists seller_listings_workspace_id_id_uidx
  on public.seller_listings(workspace_id, id);
create unique index if not exists property_units_workspace_id_id_uidx
  on public.property_units(workspace_id, id);

-- Workspace-leading indexes keep parent updates/deletes and tenant-qualified
-- integrity checks bounded. Existing broader indexes are reused when their
-- leading columns already cover the relation.
create index if not exists funnels_workspace_project_guard_idx
  on public.funnels(workspace_id, project_id)
  where project_id is not null;
create index if not exists funnels_workspace_owner_guard_idx
  on public.funnels(workspace_id, owner_user_id)
  where owner_user_id is not null;

create index if not exists funnel_steps_workspace_project_guard_idx
  on public.funnel_steps(workspace_id, project_id)
  where project_id is not null;
create index if not exists funnel_steps_workspace_funnel_guard_idx
  on public.funnel_steps(workspace_id, funnel_id);
create index if not exists funnel_steps_workspace_bot_guard_idx
  on public.funnel_steps(workspace_id, bot_rule_id)
  where bot_rule_id is not null;

-- property_inquiries_workspace_route_idx already covers (workspace_id,
-- project_id), so only the remaining tenant-qualified lookup paths are added.
create index if not exists property_inquiries_workspace_property_guard_idx
  on public.property_inquiries(workspace_id, property_id)
  where property_id is not null;
create index if not exists property_inquiries_workspace_unit_guard_idx
  on public.property_inquiries(workspace_id, unit_id)
  where unit_id is not null;
create index if not exists property_inquiries_workspace_contact_guard_idx
  on public.property_inquiries(workspace_id, contact_id)
  where contact_id is not null;
create index if not exists property_inquiries_workspace_lead_guard_idx
  on public.property_inquiries(workspace_id, lead_id)
  where lead_id is not null;
create index if not exists property_inquiries_workspace_funnel_guard_idx
  on public.property_inquiries(workspace_id, funnel_id)
  where funnel_id is not null;
create index if not exists property_inquiries_workspace_form_guard_idx
  on public.property_inquiries(workspace_id, form_id)
  where form_id is not null;
create index if not exists property_inquiries_workspace_owner_guard_idx
  on public.property_inquiries(workspace_id, owner_user_id)
  where owner_user_id is not null;

-- property_activity_workspace_entity_idx already covers (workspace_id,
-- property_id). The remaining relations receive dedicated lookup paths.
create index if not exists property_activity_workspace_project_guard_idx
  on public.property_activity_events(workspace_id, project_id)
  where project_id is not null;
create index if not exists property_activity_workspace_unit_guard_idx
  on public.property_activity_events(workspace_id, unit_id)
  where unit_id is not null;
create index if not exists property_activity_workspace_contact_guard_idx
  on public.property_activity_events(workspace_id, contact_id)
  where contact_id is not null;
create index if not exists property_activity_workspace_lead_guard_idx
  on public.property_activity_events(workspace_id, lead_id)
  where lead_id is not null;
create index if not exists property_activity_workspace_actor_guard_idx
  on public.property_activity_events(workspace_id, actor_user_id)
  where actor_user_id is not null;

-- DEFERRABLE preserves the existing scalar-FK ON DELETE SET NULL/CASCADE
-- behavior: the legacy action completes before the composite check at commit.
-- bot_rule_id has no legacy scalar FK, so its composite FK explicitly clears
-- only bot_rule_id and never the NOT NULL workspace_id.
do $migration$
declare
  tenant_fk record;
begin
  for tenant_fk in
    select *
    from (values
      ('funnels', 'funnels_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('funnels', 'funnels_workspace_owner_fk',
        'foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('funnel_steps', 'funnel_steps_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('funnel_steps', 'funnel_steps_workspace_funnel_fk',
        'foreign key (workspace_id, funnel_id) references public.funnels(workspace_id, id) deferrable initially deferred not valid'),
      ('funnel_steps', 'funnel_steps_workspace_bot_fk',
        'foreign key (workspace_id, bot_rule_id) references public.bots(workspace_id, id) on delete set null (bot_rule_id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_property_fk',
        'foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_unit_fk',
        'foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_contact_fk',
        'foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_lead_fk',
        'foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_funnel_fk',
        'foreign key (workspace_id, funnel_id) references public.funnels(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_form_fk',
        'foreign key (workspace_id, form_id) references public.forms(workspace_id, id) deferrable initially deferred not valid'),
      ('property_inquiries', 'property_inquiries_workspace_owner_fk',
        'foreign key (workspace_id, owner_user_id) references public.workspace_users(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_property_fk',
        'foreign key (workspace_id, property_id) references public.seller_listings(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_unit_fk',
        'foreign key (workspace_id, unit_id) references public.property_units(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_contact_fk',
        'foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_lead_fk',
        'foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) deferrable initially deferred not valid'),
      ('property_activity_events', 'property_activity_events_workspace_actor_fk',
        'foreign key (workspace_id, actor_user_id) references public.workspace_users(workspace_id, id) deferrable initially deferred not valid')
    ) as definitions(table_name, constraint_name, definition)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = tenant_fk.constraint_name
        and conrelid = ('public.' || tenant_fk.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I %s',
        tenant_fk.table_name,
        tenant_fk.constraint_name,
        tenant_fk.definition
      );
    end if;
  end loop;
end;
$migration$;
