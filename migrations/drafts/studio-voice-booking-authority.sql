-- REVIEW DRAFT ONLY. Install after 108/109/111/112 under the authorized booking migration owner.
-- No principal, grant, publication, activation, credential or provider is installed/enabled here.
begin;
set local lock_timeout='5s';
set local statement_timeout='2min';

create table public.studio_voice_principals (
 id uuid primary key,
 workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
 actor_user_id uuid not null,
 identity_id text not null unique check(identity_id='NOVALURE_STUDIO_VOICE_BOOKING'),
 issuer text not null check(issuer='https://oidc.vercel.com/novalure'),
 audience text not null check(audience='urn:novalure:crm:studio:voice-booking:production'),
 project_id text not null check(project_id='prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I'),
 owner_id text not null check(owner_id='team_sjD78IkSicXJK6TAOR1JC7Wv'),
 subject text not null check(subject='owner:novalure:project:evelyn:environment:production'),
 environment text not null check(environment='production'),
 enabled boolean not null default false, kill_switch boolean not null default false,
 valid_from timestamptz not null, valid_until timestamptz not null check(valid_until>valid_from), revoked_at timestamptz,
 authority_reference text not null check(length(btrim(authority_reference)) between 1 and 1024),
 unique(workspace_id,id), foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id)
);
create table public.studio_voice_booking_grants (
 id uuid primary key, workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
 principal_id uuid not null, bot_id uuid not null, publication_id uuid not null,
 publication_revision bigint not null check(publication_revision>0), assignment_id uuid not null, organizer_id uuid not null,
 connection_id uuid not null, connection_revision bigint not null check(connection_revision>0),
 account_id text not null check(length(account_id) between 1 and 2048), calendar_id text not null check(length(calendar_id) between 1 and 2048),
 production_activation_id uuid not null, production_origin text not null check(production_origin~'^https://[^/@?#[:space:]]+$'),
 enabled boolean not null default false, kill_switch boolean not null default false,
 valid_from timestamptz not null, valid_until timestamptz not null check(valid_until>valid_from), revoked_at timestamptz,
 authority_reference text not null check(length(btrim(authority_reference)) between 1 and 1024),
 unique(workspace_id,id),
 foreign key(workspace_id,principal_id) references public.studio_voice_principals(workspace_id,id),
 foreign key(workspace_id,bot_id) references public.bots(workspace_id,id),
 foreign key(workspace_id,publication_id,assignment_id) references public.booking_publication_assignments(workspace_id,publication_id,id),
 foreign key(workspace_id,organizer_id,connection_id) references public.booking_calendar_connections(workspace_id,user_id,id)
);
create unique index studio_voice_one_enabled_grant on public.studio_voice_booking_grants(principal_id) where enabled and revoked_at is null;
revoke all on public.studio_voice_principals,public.studio_voice_booking_grants from public,novalure_app,novalure_tenant_app;
alter table public.studio_voice_principals enable row level security;
alter table public.studio_voice_principals force row level security;
alter table public.studio_voice_booking_grants enable row level security;
alter table public.studio_voice_booking_grants force row level security;

-- Private migration-owner policies make FORCE RLS effective without requiring BYPASSRLS.
-- They grant nothing to the runtime and expose no additional public lookup.
do $policies$
declare rel text;
begin
 foreach rel in array array['studio_voice_principals','studio_voice_booking_grants','workspace_users','bots',
   'booking_publications','booking_publication_assignments','booking_calendar_connections','booking_production_activations',
   'workspace_module_settings','booking_channel_sessions'] loop
  execute format('create policy studio_voice_owner_read on public.%I for select to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',rel,current_user);
 end loop;
 foreach rel in array array['workspace_users','bots','booking_publications','booking_publication_assignments','booking_calendar_connections','booking_production_activations'] loop
  -- PostgreSQL row-lock reads also apply UPDATE visibility. No actual owner mutation is admitted.
  execute format('create policy studio_voice_owner_lock on public.%I for update to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid) with check(false)',rel,current_user);
 end loop;
 foreach rel in array array['studio_voice_principals','studio_voice_booking_grants'] loop
  execute format('create policy studio_voice_owner_install on public.%I for insert to %I with check(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',rel,current_user);
  execute format('create policy studio_voice_owner_revoke on public.%I for update to %I using(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid) with check(workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',rel,current_user);
 end loop;
 execute format('create policy studio_voice_owner_workspace on public.workspaces for select to %I using(id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid)',current_user);
 execute format('create policy studio_voice_owner_identity on public.auth_identities for select to %I using(exists(select 1 from public.workspace_users u where u.auth_identity_id=auth_identities.id and u.workspace_id=''8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101''::uuid))',current_user);
end $policies$;

-- Original sessions retain their exact resources. An administrator must install a new versioned
-- principal/grant for a different binding; existing records/fences are never retargeted or revived.
create function public._studio_voice_authority_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op in ('DELETE','TRUNCATE') then raise exception using errcode='42501',message='STUDIO_VOICE_BINDING_IMMUTABLE'; end if;
 if (to_jsonb(new)-array['enabled','kill_switch','revoked_at']) is distinct from (to_jsonb(old)-array['enabled','kill_switch','revoked_at'])
  or (old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.enabled))
 then raise exception using errcode='42501',message='STUDIO_VOICE_BINDING_IMMUTABLE'; end if;
 return new;
end $$;
create trigger studio_voice_principal_binding_immutable before update or delete on public.studio_voice_principals
 for each row execute function public._studio_voice_authority_immutable();
create trigger studio_voice_grant_binding_immutable before update or delete on public.studio_voice_booking_grants
 for each row execute function public._studio_voice_authority_immutable();
create trigger studio_voice_principal_tombstones before truncate on public.studio_voice_principals
 for each statement execute function public._studio_voice_authority_immutable();
create trigger studio_voice_grant_tombstones before truncate on public.studio_voice_booking_grants
 for each statement execute function public._studio_voice_authority_immutable();

create function public._studio_voice_runtime_safe() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare rel regclass;
begin
 if exists(select 1 from pg_roles where rolname=session_user and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
 then raise exception using errcode='42501',message='STUDIO_VOICE_BOOKING_DENIED'; end if;
 foreach rel in array array['public.studio_voice_principals'::regclass,'public.studio_voice_booking_grants'::regclass] loop
  if has_table_privilege(session_user,rel,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_any_column_privilege(session_user,rel,'SELECT,INSERT,UPDATE,REFERENCES')
   or exists(select 1 from pg_class where oid=rel and (not relrowsecurity or not relforcerowsecurity or pg_has_role(session_user,relowner,'MEMBER')))
  then raise exception using errcode='42501',message='STUDIO_VOICE_BOOKING_DENIED'; end if;
 end loop;
end $$;

-- Fixed structured predicate, not a general tenant query. Locks are held by the caller's transaction.
create function public._studio_voice_grant_allowed(p_principal uuid,p_grant uuid,p_workspace uuid,p_publication uuid,p_revision bigint,p_assignment uuid,p_organizer uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare principal public.studio_voice_principals; g public.studio_voice_booking_grants; matched boolean;
begin
 perform public._studio_voice_runtime_safe();
 if p_workspace is distinct from '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid then return false; end if;
 select * into principal from public.studio_voice_principals where id=p_principal and workspace_id=p_workspace
  and enabled and not kill_switch and revoked_at is null and valid_from<=clock_timestamp() and valid_until>clock_timestamp() for share;
 if not found then return false; end if;
 select * into g from public.studio_voice_booking_grants where id=p_grant and principal_id=principal.id and workspace_id=p_workspace
  and enabled and not kill_switch and revoked_at is null and valid_from<=clock_timestamp() and valid_until>clock_timestamp() for share;
 if not found or g.publication_id is distinct from p_publication or g.publication_revision is distinct from p_revision
  or g.assignment_id is distinct from p_assignment or g.organizer_id is distinct from p_organizer then return false; end if;
 -- Owner-only policies expose this one fixed Studio scope. Never rewrite the caller's tenant/actor GUCs.
 select true into matched from public.workspace_users actor
  join public.bots bot on bot.workspace_id=g.workspace_id and bot.id=g.bot_id
  join public.booking_publications pub on pub.workspace_id=g.workspace_id and pub.id=g.publication_id
  join public.booking_publication_assignments a on a.workspace_id=g.workspace_id and a.publication_id=pub.id and a.id=g.assignment_id
  join public.booking_calendar_connections c on c.workspace_id=g.workspace_id and c.user_id=g.organizer_id and c.id=g.connection_id
  join public.booking_production_activations activation on activation.workspace_id=g.workspace_id and activation.user_id=g.organizer_id
   and activation.activation_id=g.production_activation_id and activation.provider='microsoft' and activation.connection_id=g.connection_id
  where actor.workspace_id=p_workspace and actor.id=principal.actor_user_id and actor.status='active' and actor.role='agent'
   and actor.product_role='novalure_operator'
   and actor.name!~*'(^|[[:space:]_-])(synthetic|qa)([[:space:]_-]|$)'
   and actor.email!~*'(@|[.])(invalid|test|localhost)$|@example[.](com|net|org)$'
   and exists(select 1 from public.workspaces w where w.id=p_workspace and not w.is_qa)
   and pub.enabled and pub.revision=g.publication_revision and pub.config->'enabled'='true'::jsonb and pub.config->'channels'->'voice'='true'::jsonb
   and a.enabled and a.kind='teams' and a.provider='microsoft' and a.organizer_id=g.organizer_id
   and exists(select 1 from jsonb_array_elements(pub.config->'assignments') item where item->>'id'=a.id::text
    and item->>'organizerId'=g.organizer_id::text and item->>'kind'='teams' and item->>'provider'='microsoft')
   and bot.config->'booking'->'enabled'='true'::jsonb and bot.config->'booking'->>'publicId'=pub.public_id
   and bot.config->'booking'->'channels'?'voice' and bot.config->'booking'->'typeIds'?g.assignment_id::text
   and not exists(select 1 from public.workspace_module_settings m where m.workspace_id=p_workspace and m.module_key='bots' and not m.enabled)
   and c.status='connected' and c.provider='microsoft' and c.revision=g.connection_revision and c.account_id=g.account_id and c.write_calendar_id=g.calendar_id
   and exists(select 1 from jsonb_array_elements(c.calendars) k where k->>'id'=g.calendar_id and k->'teamsSupported'='true'::jsonb)
   and activation.status='active' and activation.account_id=g.account_id and activation.calendar_id=g.calendar_id
   and activation.production_origin=g.production_origin and activation.activated_at<=clock_timestamp() and 'booking'=any(activation.capabilities)
   and public.booking_production_connection_eligible(g.workspace_id,g.organizer_id,g.connection_id,'microsoft',g.account_id,g.calendar_id)
  for share of actor,bot,pub,a,c,activation;
 return coalesce(matched,false);
end $$;

-- Authentication bootstrap accepts ONLY claims already verified by the separate Studio JWT verifier.
-- SQL is not an independent cryptographic JWT verifier. This lookup returns no calendar/token/PII.
create function public.studio_voice_authenticate(p_subject text,p_issuer text,p_audience text,p_project text,p_owner text,p_environment text)
returns table(principal_id uuid,grant_id uuid,workspace_id uuid,public_id text,type_id uuid)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare principal public.studio_voice_principals; g public.studio_voice_booking_grants; pub text;
begin
 perform public._studio_voice_runtime_safe();
 select * into principal from public.studio_voice_principals p where p.identity_id='NOVALURE_STUDIO_VOICE_BOOKING'
  and p.subject=p_subject and p.issuer=p_issuer and p.audience=p_audience and p.project_id=p_project and p.owner_id=p_owner and p.environment=p_environment
  and p.enabled and not p.kill_switch and p.revoked_at is null and p.valid_from<=clock_timestamp() and p.valid_until>clock_timestamp() for share;
 if not found then return; end if;
 select * into g from public.studio_voice_booking_grants bg where bg.principal_id=principal.id and bg.enabled and bg.revoked_at is null for share;
 if not found or not public._studio_voice_grant_allowed(principal.id,g.id,g.workspace_id,g.publication_id,g.publication_revision,g.assignment_id,g.organizer_id) then return; end if;
 select bp.public_id into pub from public.booking_publications bp where bp.workspace_id=g.workspace_id and bp.id=g.publication_id;
 return query select principal.id,g.id,g.workspace_id,pub,g.assignment_id;
end $$;

-- The initial authority read cannot race a revocation into a committed session/budget write.
-- Later updates preserve exact original scope, token, creation/deadline and grant identity.
create function public._studio_voice_session_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.relation->>'source'='studio_voice' then
  if (to_jsonb(new)-array['request_count','hold_count','revoked_at']) is distinct from (to_jsonb(old)-array['request_count','hold_count','revoked_at'])
   or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
   or new.request_count<old.request_count or new.hold_count<old.hold_count
  then raise exception using errcode='42501',message='STUDIO_VOICE_BOOKING_DENIED'; end if;
  -- An expired/revoked original record remains fenced; a terminal revoke may still be persisted.
  if new.revoked_at is not null then return new; end if;
 end if;
 if new.relation->>'source'='studio_voice' then
  if new.channel<>'voice' or new.origin<>'trusted:voice' or (select count(*) from jsonb_object_keys(new.relation))<>2
   or new.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
   or new.organizer_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
   or coalesce(new.binding_id,'')!~*'^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
   or coalesce(new.relation->>'sourceId','')!~*'^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
   or new.expires_at<=clock_timestamp() or new.created_at>clock_timestamp()+interval '1 second'
   or new.expires_at>new.created_at+interval '30 minutes'
   or not public._studio_voice_grant_allowed(new.binding_id::uuid,(new.relation->>'sourceId')::uuid,new.workspace_id,
     new.publication_id,new.publication_revision,new.assignment_id,new.organizer_id)
  then raise exception using errcode='42501',message='STUDIO_VOICE_BOOKING_DENIED'; end if;
 end if;
 return new;
end $$;
create trigger studio_voice_session_scope before insert or update on public.booking_channel_sessions
for each row execute function public._studio_voice_session_guard();

-- Preserve the existing legacy/chat/form upstream implementation exactly. Only this Studio relation
-- selects the separate predicate inside the existing engine's claim and pre-provider authorization.
create or replace function public.booking_channel_authorize_session(p_session uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.booking_channel_sessions;
begin
 select s0.* into s from public.booking_channel_sessions s0
 join public.booking_publications p on p.id=s0.publication_id and p.workspace_id=s0.workspace_id
 join public.booking_publication_assignments a on a.id=s0.assignment_id and a.workspace_id=s0.workspace_id and a.organizer_id=s0.organizer_id
 where s0.id=p_session and public.booking_actor_allowed(s0.workspace_id,s0.organizer_id)
 and s0.revoked_at is null and s0.expires_at>now() and p.enabled and a.enabled and p.revision=s0.publication_revision
 and coalesce((p.config->'channels'->>s0.channel)::boolean,false) for share of p,a;
 if not found then return false; end if;
 if s.relation->>'source'='studio_voice' then
  if s.channel<>'voice' or s.origin<>'trusted:voice' or s.binding_id is null then return false; end if;
  return public._studio_voice_grant_allowed(s.binding_id::uuid,(s.relation->>'sourceId')::uuid,s.workspace_id,s.publication_id,
    s.publication_revision,s.assignment_id,s.organizer_id);
 end if;
 return public.booking_channel_upstream_allowed(p_session);
end $$;

revoke all on function public._studio_voice_authority_immutable(),public._studio_voice_runtime_safe(),public._studio_voice_grant_allowed(uuid,uuid,uuid,uuid,bigint,uuid,uuid),
 public._studio_voice_session_guard(),public.studio_voice_authenticate(text,text,text,text,text,text) from public,novalure_app,novalure_tenant_app;
grant execute on function public.studio_voice_authenticate(text,text,text,text,text,text) to novalure_tenant_app;
-- Existing public signature/ACL remain explicit and unchanged for the original booking engine.
revoke all on function public.booking_channel_authorize_session(uuid) from public,novalure_app;
grant execute on function public.booking_channel_authorize_session(uuid) to novalure_tenant_app;
commit;
