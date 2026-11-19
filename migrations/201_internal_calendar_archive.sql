-- Supported internal-calendar archive. No table grants, owner changes or provider actions.
-- Released 169's literal-true schema-owner read policy must expose all viewing links.
set local lock_timeout='5s';
set local statement_timeout='14min';
lock table public.calendar_events,public.property_viewing_slots,public.calendar_sync_events,public.teams_notification_jobs,public.google_notification_jobs in share row exclusive mode;

do $$ declare relation oid;begin
 foreach relation in array array['public.calendar_events'::regclass,'public.property_viewing_slots'::regclass] loop
   if row_security_active(relation) and (
     not exists(select 1 from pg_policy p where p.polrelid=relation and p.polcmd in('r','*') and p.polpermissive
       and pg_get_expr(p.polqual,p.polrelid)='true'
       and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) r where pg_has_role(current_user,r,'USAGE'))))
     or exists(select 1 from pg_policy p where p.polrelid=relation and p.polcmd in('r','*') and not p.polpermissive
       and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) r where pg_has_role(current_user,r,'USAGE'))))
   ) then raise exception using errcode='42501',message='201 requires complete existing schema-owner calendar/viewing visibility'; end if;
 end loop;
 if exists(select 1 from public.calendar_events where metadata ? 'internalCalendarArchive')
 then raise exception using errcode='55000',message='201 refuses pre-existing reserved calendar archive markers; investigate before cutover'; end if;
end $$;

-- Private implementation: row_security=off raises on an RLS-filtered read; it does not bypass RLS.
-- A future queue policy, missing relation or missing privilege must never mean "no dependency".
create function public.crm_internal_calendar_dependency_exists(p_event uuid)
returns boolean language sql security definer set search_path=pg_catalog,public,pg_temp set row_security=off as $$
 select exists(select 1 from public.calendar_sync_events where calendar_event_id=p_event)
   or exists(select 1 from public.teams_notification_jobs where calendar_event_id=p_event)
   or exists(select 1 from public.google_notification_jobs where calendar_event_id=p_event)
$$;
revoke all on function public.crm_internal_calendar_dependency_exists(uuid) from public,novalure_app,novalure_tenant_app;

create function public.crm_internal_calendar_archive_unlinked(p_workspace uuid,p_actor uuid,p_event uuid,p_session uuid,p_identity uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare member record; event record; viewing_oid oid:='public.property_viewing_slots'::regclass;
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
   or p_actor is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
   or p_session is null or p_identity is null then return false; end if;
 select * into member from public.crm_lock_active_member(p_workspace,p_actor);
 if not found or member.auth_identity_id is distinct from p_identity or member.role not in('owner','admin','agent')
   or member.product_role not in('platform_admin','novalureAdmin','novalure_onboarding','novalure_customer_success','customer_owner','workspace_admin')
   or not(member.role in('owner','admin') or member.product_role in('platform_admin','novalure_onboarding','novalure_customer_success','customer_owner','workspace_admin'))
   or not public.crm_lock_active_session(p_session,p_identity) then return false; end if;
 select id,workspace_id,project_id,metadata,data_classification,data_purpose into event
   from public.calendar_events where id=p_event and workspace_id=p_workspace for update;
 if not found or event.project_id is null or event.metadata->>'source' is distinct from 'crm_internal_calendar_event'
   or event.metadata->>'calendarProvider' is distinct from 'manual' or event.metadata->'externalCommunication' is distinct from 'false'::jsonb
   or event.metadata ?| array['bookingId','viewingId','propertyId','externalCalendarId','personalCalendarState']
   or not public.crm_classification_allowed(p_workspace,event.data_classification,event.data_purpose)
   or not exists(select 1 from public.projects p where p.id=event.project_id and p.workspace_id=p_workspace and public.crm_classification_allowed(p_workspace,p.data_classification,p.data_purpose))
   or not public.crm_lock_project_access(p_workspace,event.project_id,true) then return false; end if;
 -- FORCE RLS is allowed only with an applicable unconditional owner policy and no restrictive filter.
 -- Otherwise even a real but hidden viewing row could be mistaken for absence.
 if exists(select 1 from pg_class where oid=viewing_oid and relrowsecurity) and (
   not exists(select 1 from pg_policy p where p.polrelid=viewing_oid and p.polcmd in('r','*') and p.polpermissive
     and pg_get_expr(p.polqual,p.polrelid)='true'
     and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) r where pg_has_role(current_user,r,'USAGE'))))
   or exists(select 1 from pg_policy p where p.polrelid=viewing_oid and p.polcmd in('r','*') and not p.polpermissive
     and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) r where pg_has_role(current_user,r,'USAGE'))))
 ) then return false; end if;
 if exists(select 1 from public.property_viewing_slots where calendar_event_id=p_event)
   or public.crm_internal_calendar_dependency_exists(p_event) then return false; end if;
 return true;
exception when others then return false;
end $$;
revoke all on function public.crm_internal_calendar_archive_unlinked(uuid,uuid,uuid,uuid,uuid) from public,novalure_app;
grant execute on function public.crm_internal_calendar_archive_unlinked(uuid,uuid,uuid,uuid,uuid) to novalure_tenant_app;

create function public.crm_internal_calendar_archive_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare proof jsonb;
begin
 if tg_op='INSERT' then
   if new.metadata ? 'internalCalendarArchive' then raise exception using errcode='23514',message='Calendar archive marker cannot be inserted'; end if;
   return new;
 end if;
 if old.metadata ? 'internalCalendarArchive' then
   if to_jsonb(new) is distinct from to_jsonb(old) then raise exception using errcode='23514',message='Archived internal calendar event is immutable'; end if;
   return new;
 end if;
 if not(new.metadata ? 'internalCalendarArchive') then return new; end if;
 proof:=new.metadata->'internalCalendarArchive';
 if jsonb_typeof(proof) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(proof))<>4
   or not(proof ?& array['archivedAt','archivedByUserId','authSessionId','authIdentityId'])
   or exists(select 1 from jsonb_each(proof) p where jsonb_typeof(p.value)<>'string')
   or proof->>'archivedByUserId' is distinct from nullif(current_setting('app.actor_id',true),'')
   or new.status<>'abgesagt'
   or (to_jsonb(new)-array['status','metadata','updated_at']) is distinct from (to_jsonb(old)-array['status','metadata','updated_at'])
   or new.metadata-'internalCalendarArchive' is distinct from old.metadata
   or not public.crm_internal_calendar_archive_unlinked(new.workspace_id,(proof->>'archivedByUserId')::uuid,new.id,(proof->>'authSessionId')::uuid,(proof->>'authIdentityId')::uuid)
 then raise exception using errcode='23514',message='Current authorized unlinked internal calendar archive required'; end if;
 perform (proof->>'archivedAt')::timestamptz;
 new.metadata:=jsonb_set(new.metadata,'{internalCalendarArchive,archivedAt}',to_jsonb(clock_timestamp()));
 return new;
end $$;
create trigger internal_calendar_archive_guard before insert or update on public.calendar_events
for each row execute function public.crm_internal_calendar_archive_guard();
revoke all on function public.crm_internal_calendar_archive_guard() from public;
grant execute on function public.crm_internal_calendar_archive_guard() to novalure_app,novalure_tenant_app;

-- Serialize new references against the archive row lock, including a reference inserted after the first read.
create function public.crm_internal_calendar_reference_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare target record;
begin
 if new.calendar_event_id is null or (tg_op='UPDATE' and new.calendar_event_id is not distinct from old.calendar_event_id and new.workspace_id is not distinct from old.workspace_id) then return new; end if;
 select workspace_id,metadata into target from public.calendar_events where id=new.calendar_event_id for key share;
 if not found or target.workspace_id is distinct from new.workspace_id or target.metadata ? 'internalCalendarArchive'
 then raise exception using errcode='23514',message='Current calendar reference required'; end if;
 return new;
end $$;
do $$ declare relation text;begin
 foreach relation in array array['property_viewing_slots','calendar_sync_events','teams_notification_jobs','google_notification_jobs'] loop
   execute format('create trigger internal_calendar_reference_guard before insert or update of workspace_id,calendar_event_id on public.%I for each row execute function public.crm_internal_calendar_reference_guard()',relation);
 end loop;
end $$;
revoke all on function public.crm_internal_calendar_reference_guard() from public;
grant execute on function public.crm_internal_calendar_reference_guard() to novalure_app,novalure_tenant_app;
