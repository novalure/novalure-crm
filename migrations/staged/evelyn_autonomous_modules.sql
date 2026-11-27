-- Manual successor of the reviewed access and personal-source stages.
-- Installs no principal, assignment, business record, key or approval.
set local lock_timeout='5s';
set local statement_timeout='14min';

alter table public.crm_autonomous_access_grants
  add column contract_version text not null default 'crm-autonomous-access-v1',
  add column read_fields text[] not null default '{}',
  add column write_fields text[] not null default '{}',
  add column related_resources jsonb not null default '{}',
  add column lifecycle_mode text not null default 'EXISTING',
  add column parent_grant_id uuid references public.crm_autonomous_access_grants(id),
  add column delegation_kind text not null default 'DEPARTMENT';

-- Replace only the original Task/Project vocabulary checks. Tenant-composite
-- foreign keys, immutable attribution and RLS remain unchanged.
do $vocabulary$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.crm_autonomous_access_grants'::regclass
    and contype='c' and (pg_get_constraintdef(oid) like '%entity%' or pg_get_constraintdef(oid) like '%scopes%') loop
    execute format('alter table public.crm_autonomous_access_grants drop constraint %I',c.conname);
  end loop;
end $vocabulary$;

create function public.crm_autonomous_module_scopes_valid(p_entity text,p_scopes text[])
returns boolean language sql immutable set search_path=pg_catalog,public as $function$
 select cardinality(p_scopes)>0 and p_scopes <@ case p_entity
  when 'Contact' then array['crm.contacts.read','crm.contacts.write','crm.contacts.create']
  when 'Company' then array['crm.companies.read','crm.companies.write','crm.companies.create']
  when 'Developer' then array['crm.developers.read','crm.developers.write','crm.developers.create']
  when 'Project' then array['crm.projects.read','crm.projects.write']
  when 'Unit' then array['crm.units.read','crm.units.write','crm.units.create']
  when 'BuyerLead' then array['crm.leads.read','crm.leads.write','crm.leads.create']
  when 'Qualification' then array['crm.qualifications.read','crm.qualifications.write']
  when 'Offer' then array['crm.offers.read','crm.offers.prepare','crm.offers.send']
  when 'Task' then array['crm.tasks.read','crm.tasks.write','crm.tasks.create']
  when 'Appointment' then array['crm.appointments.read','crm.appointments.write','crm.appointments.create']
  when 'Viewing' then array['crm.viewings.read','crm.viewings.write']
  when 'Reservation' then array['crm.reservations.read','crm.reservations.write','crm.reservations.prepare','crm.reservations.confirm']
  when 'Sale' then array['crm.sales.read','crm.sales.confirm']
  when 'Communication' then array['crm.communications.read','crm.communications.write','crm.communications.create']
  when 'ApprovalReference' then array['crm.approvals.read'] else array[]::text[] end
$function$;
revoke all on function public.crm_autonomous_module_scopes_valid(text,text[]) from public;
-- CHECK evaluation is a pure closed-vocabulary function, not a registry lookup.
grant execute on function public.crm_autonomous_module_scopes_valid(text,text[]) to novalure_tenant_app;

alter table public.crm_autonomous_access_grants
 add constraint autonomous_contract_version check(contract_version in('crm-autonomous-access-v1','crm-autonomous-access-v2')),
 add constraint autonomous_module_entity check(entity in('Contact','Company','Developer','Project','Unit','BuyerLead','Qualification','Offer','Task','Appointment','Viewing','Reservation','Sale','Communication','ApprovalReference')),
 add constraint autonomous_module_scope check(public.crm_autonomous_module_scopes_valid(entity,scopes)),
 add constraint autonomous_legacy_scope check(contract_version<>'crm-autonomous-access-v1' or
   ((entity='Task' and scopes <@ array['crm.tasks.read','crm.tasks.write']) or (entity='Project' and scopes=array['crm.projects.read']))),
 add constraint autonomous_project_source check(entity<>'Project' or source_id=project_id),
 add constraint autonomous_module_fields check(cardinality(read_fields)<=40 and cardinality(write_fields)<=40
   and array_position(read_fields,null) is null and array_position(write_fields,null) is null),
 add constraint autonomous_module_relations check(jsonb_typeof(related_resources)='object' and octet_length(related_resources::text)<=4096),
 add constraint autonomous_module_parent check((delegation_kind='DEPARTMENT' and parent_grant_id is null)
   or (delegation_kind='SUBAGENT' and parent_grant_id is not null and parent_grant_id<>id)),
 add constraint autonomous_module_lifecycle check(lifecycle_mode in('EXISTING','CREATE') and
   (lifecycle_mode<>'CREATE' or (contract_version='crm-autonomous-access-v2' and entity in('Contact','Company','Developer','Unit','BuyerLead','Task','Appointment','Communication','Offer','Reservation','Sale'))));

alter table public.crm_autonomous_access_events drop constraint crm_autonomous_access_events_action_check;
alter table public.crm_autonomous_access_events add constraint autonomous_module_event_action
 check(action ~ '^crm\.(contacts|companies|developers|projects|units|leads|qualifications|offers|tasks|appointments|viewings|reservations|sales|communications|approvals)\.(read|write|create|prepare|send|confirm)$');

-- Existing UI/provider writes must invalidate a module CAS even when their
-- historical code does not know the new column. No existing row is reclassified.
alter table public.calendar_events add column if not exists version bigint not null default 1 check(version>0);
alter table public.conversations add column if not exists version bigint not null default 1 check(version>0);
create function public.crm_autonomous_module_version_guard() returns trigger
 language plpgsql set search_path=pg_catalog,public as $function$
 begin new.version=old.version+1; return new; end $function$;
create trigger autonomous_calendar_version before update on public.calendar_events
 for each row execute function public.crm_autonomous_module_version_guard();
create trigger autonomous_conversation_version before update on public.conversations
 for each row execute function public.crm_autonomous_module_version_guard();

-- Conversations retain the authoritative existing RLS policy. Existing
-- unclassified conversations are not promoted. New timeline-only inserts pass
-- the same internal classification guard used by all other CRM records.
create trigger autonomous_conversation_classification before insert or update on public.conversations
 for each row execute function public.crm_set_sales_classification();

-- The designated schema owner must own contacts as well as the affected tables.
-- FORCE RLS remains in force even for that non-runtime owner. The narrow helper
-- may lock only the exact contact saved on the executing actor's assignment.
do $contact_owner_policy$ begin
 execute format('create policy autonomous_owner_contact_relation on public.contacts for select to %I using (
  workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid
  and workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
  and exists(select 1 from public.crm_autonomous_access_grants g where g.workspace_id=contacts.workspace_id
   and g.actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid
   and g.entity=''Communication'' and g.related_resources->>''contactId''=contacts.id::text))',current_user);
 execute format('create policy autonomous_owner_contact_lock on public.contacts for update to %I using (
  workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid
  and workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
  and exists(select 1 from public.crm_autonomous_access_grants g where g.workspace_id=contacts.workspace_id
   and g.actor_user_id=nullif(current_setting(''app.actor_id'',true),'''')::uuid
   and g.entity=''Communication'' and g.related_resources->>''contactId''=contacts.id::text)) with check(false)',current_user);
end $contact_owner_policy$;

-- Extend the preexisting personal-safe lock predicate only for write capability
-- checks. The source identity, actors, authority, expiry and project predicates
-- are preserved by wrapping the original implementation under a private name.
alter function public.crm_lock_autonomous_access_grant(uuid,uuid) rename to crm_lock_autonomous_access_grant_v1;
revoke all on function public.crm_lock_autonomous_access_grant_v1(uuid,uuid) from public,novalure_app,novalure_tenant_app;
create function public.crm_lock_autonomous_access_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_autonomous_access_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
 select g.* from public.crm_lock_autonomous_access_grant_v1(p_workload,p_grant) g
 where not exists(select 1 from unnest(g.scopes) scope where scope !~ '\.read$')
  or exists(select 1 from public.project_pipeline_permissions p where p.workspace_id=g.workspace_id
   and p.project_id=g.project_id and p.user_id=g.actor_user_id and p.can_read and p.can_edit_deals)
$function$;
revoke all on function public.crm_lock_autonomous_access_grant(uuid,uuid) from public,novalure_app;
grant execute on function public.crm_lock_autonomous_access_grant(uuid,uuid) to novalure_tenant_app;

create function public.crm_lock_autonomous_parent_chain(p_workload uuid,p_grant uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
declare chain_ids uuid[]; terminated boolean; item uuid; valid_count int; begin
 with recursive chain as (
  select g.id,g.parent_grant_id,array[g.id] path,1 depth from public.crm_autonomous_access_grants g where g.id=p_grant and g.workload_id=p_workload
  union all select p.id,p.parent_grant_id,c.path||p.id,c.depth+1 from chain c
   join public.crm_autonomous_access_grants p on p.id=c.parent_grant_id
   where c.depth<8 and not p.id=any(c.path)
 ) select array_agg(id order by id),bool_or(parent_grant_id is null) into chain_ids,terminated from chain;
 if chain_ids is null or terminated is not true then return false; end if;
 -- Immutable parent links are read before any locks; then acquire EVERY grant
 -- in one total order. An owner revoke cannot commit between this check/effect.
 perform g.id from public.crm_autonomous_access_grants g where g.id=any(chain_ids) order by g.id for share;
 foreach item in array chain_ids loop
  select count(*) into valid_count from public.crm_lock_autonomous_access_grant_v1(p_workload,item) g
   where not exists(select 1 from unnest(g.scopes) scope where scope !~ '\.read$')
    or exists(select 1 from public.project_pipeline_permissions p where p.workspace_id=g.workspace_id
      and p.project_id=g.project_id and p.user_id=g.actor_user_id and p.can_read and p.can_edit_deals);
  if valid_count<>1 then return false; end if;
 end loop;
 if exists(select 1 from public.crm_autonomous_access_grants c join public.crm_autonomous_access_grants p on p.id=c.parent_grant_id
  where c.id=any(chain_ids) and (c.workload_id<>p.workload_id or c.workspace_id<>p.workspace_id or c.project_id<>p.project_id
   or c.source_id<>p.source_id or c.entity<>p.entity or c.department_id<>p.department_id or c.task_id<>p.task_id
   or c.contract_version<>p.contract_version or c.related_resources<>p.related_resources
   or not c.scopes<@p.scopes or not c.read_fields<@p.read_fields or not c.write_fields<@p.write_fields
   or (c.lifecycle_mode='CREATE' and p.lifecycle_mode<>'CREATE'))) then return false; end if;
 return true;
end $function$;
revoke all on function public.crm_lock_autonomous_parent_chain(uuid,uuid) from public,novalure_app,novalure_tenant_app;
create or replace function public.crm_lock_autonomous_access_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_autonomous_access_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
 select g.* from public.crm_autonomous_access_grants saved
 cross join lateral (select public.crm_lock_autonomous_parent_chain(p_workload,saved.id) as allowed offset 0) chain
 cross join lateral public.crm_lock_autonomous_access_grant_v1(p_workload,case when chain.allowed then saved.id else null end) g
 where saved.id=p_grant and chain.allowed and (
  not exists(select 1 from unnest(g.scopes) scope where scope !~ '\.read$')
  or exists(select 1 from public.project_pipeline_permissions p where p.workspace_id=g.workspace_id
   and p.project_id=g.project_id and p.user_id=g.actor_user_id and p.can_read and p.can_edit_deals))
$function$;

-- The historical Communication boundary intentionally revokes direct table
-- access. Keep that boundary: these two helpers resolve only the current
-- actor's exact registered, field-limited conversation, never a free SQL ID.
create function public.crm_read_autonomous_communication(p_grant uuid)
returns table(id uuid,workspace_id uuid,project_id uuid,data_classification text,data_purpose text,
 contact_id uuid,lead_id uuid,channel text,direction text,summary text,last_message_at timestamptz,version bigint,updated_at timestamptz)
language sql volatile security definer set search_path=pg_catalog,public as $function$
 select c.id,c.workspace_id,c.project_id,c.data_classification,c.data_purpose,
  case when 'contactId'=any(g.read_fields) then c.contact_id end,
  case when 'leadId'=any(g.read_fields) then c.lead_id end,
  case when 'channel'=any(g.read_fields) then c.channel end,
  case when 'direction'=any(g.read_fields) then c.direction end,
  case when 'summary'=any(g.read_fields) then c.summary end,
  case when 'lastMessageAt'=any(g.read_fields) then c.last_message_at end,c.version,c.updated_at
 from public.crm_autonomous_access_grants saved
 cross join lateral public.crm_lock_autonomous_access_grant(saved.workload_id,saved.id) g
 join public.conversations c on c.id=g.source_id and c.workspace_id=g.workspace_id and c.project_id=g.project_id
 where saved.id=p_grant and g.contract_version='crm-autonomous-access-v2' and g.entity='Communication'
  and g.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and g.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid
  and 'crm.communications.read'=any(g.scopes) and c.data_classification='NOVALURE_INTERNAL' and c.data_purpose='crm_sales'
 for share of c
$function$;
revoke all on function public.crm_read_autonomous_communication(uuid) from public,novalure_app;
grant execute on function public.crm_read_autonomous_communication(uuid) to novalure_tenant_app;

create function public.crm_write_autonomous_communication(p_grant uuid,p_version bigint,p_summary text,p_create boolean)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $function$
declare g public.crm_autonomous_access_grants; changed uuid; relation uuid; begin
 select live.* into g from public.crm_autonomous_access_grants saved
 cross join lateral public.crm_lock_autonomous_access_grant(saved.workload_id,saved.id) live
 where saved.id=p_grant and live.contract_version='crm-autonomous-access-v2' and live.entity='Communication'
  and live.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and live.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid;
 if g.id is null or not ('summary'=any(g.write_fields)) or p_summary is null or length(trim(p_summary))=0
  or length(p_summary)>4000 or p_summary ~ '[[:cntrl:]]' then return null; end if;
 if p_create then
  if g.lifecycle_mode<>'CREATE' or not ('crm.communications.create'=any(g.scopes)) or p_version is not null then return null; end if;
  if g.related_resources ? 'contactId' then
   select c.id into relation from public.contacts c where c.id=(g.related_resources->>'contactId')::uuid
    and c.workspace_id=g.workspace_id and c.project_id=g.project_id and c.data_classification='NOVALURE_INTERNAL' and c.data_purpose='crm_sales' for share;
   if relation is null then return null; end if;
  end if;
  insert into public.conversations(id,workspace_id,project_id,contact_id,lead_id,channel,direction,summary,metadata,data_classification,data_purpose)
   values(g.source_id,g.workspace_id,g.project_id,(g.related_resources->>'contactId')::uuid,(g.related_resources->>'leadId')::uuid,
    'Webchat','internal',p_summary,'{"kind":"agent_timeline_note","externalEffect":false}','NOVALURE_INTERNAL','crm_sales')
   on conflict(id) do nothing returning conversations.id into changed;
 else
  if not ('crm.communications.write'=any(g.scopes)) or p_version<1 then return null; end if;
  update public.conversations c set summary=p_summary,updated_at=clock_timestamp()
   where c.id=g.source_id and c.workspace_id=g.workspace_id and c.project_id=g.project_id
    and c.data_classification='NOVALURE_INTERNAL' and c.data_purpose='crm_sales' and c.version=p_version returning c.id into changed;
 end if;
 return changed;
end $function$;
revoke all on function public.crm_write_autonomous_communication(uuid,bigint,text,boolean) from public,novalure_app;
grant execute on function public.crm_write_autonomous_communication(uuid,bigint,text,boolean) to novalure_tenant_app;
