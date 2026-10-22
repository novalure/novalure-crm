-- Package 5, Auftrag 3: an empty production registry. Applying this migration
-- activates no tenant, provider, scheduler, message, or public booking channel.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create table public.booking_production_activations (
 id uuid primary key default gen_random_uuid(),
 activation_id uuid not null,
 workspace_id uuid not null references public.workspaces(id),
 user_id uuid not null,
 provider text not null check(provider in ('google','microsoft')),
 connection_id uuid not null,
 account_id text not null check(length(account_id) between 1 and 2048),
 calendar_id text not null check(length(calendar_id) between 1 and 2048),
 production_origin text not null check(production_origin ~ '^https://[^/@?#[:space:]]+$'),
 status text not null default 'active' check(status in ('active','revoked')),
 capabilities text[] not null check(cardinality(capabilities)>0 and capabilities <@ array['booking','messages']::text[]),
 audience text not null default 'internal' check(audience in ('internal','external_customers')),
 review_reference text not null check(length(btrim(review_reference)) between 1 and 500),
 activated_at timestamptz not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(activation_id,workspace_id,user_id,provider),
 foreign key(workspace_id,user_id,connection_id)
   references public.booking_calendar_connections(workspace_id,user_id,id)
);
alter table public.booking_production_activations enable row level security;
alter table public.booking_production_activations force row level security;
create policy booking_production_activation_read on public.booking_production_activations
 for select to novalure_tenant_app using(public.booking_actor_allowed(workspace_id,user_id));
revoke all on public.booking_production_activations from public,novalure_app,novalure_tenant_app;
grant select on public.booking_production_activations to novalure_tenant_app;

-- Private predicate: neither runtime nor customers can use it to inspect another
-- customer's resources. The bounded public functions below return no secrets.
create function public.booking_production_connection_eligible(p_workspace uuid,p_user uuid,
 p_connection uuid,p_provider text,p_account text,p_calendar text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
  select 1 from public.booking_calendar_connections c
  join public.workspace_users u on u.workspace_id=c.workspace_id and u.id=c.user_id
  join public.workspaces w on w.id=c.workspace_id
  join public.auth_identities i on i.id=u.auth_identity_id
  where c.id=p_connection and c.workspace_id=p_workspace and c.user_id=p_user and c.provider=p_provider
  and c.account_id=p_account and c.write_calendar_id=p_calendar and c.status='connected'
  and c.encrypted_tokens like 'b1.%'
  and u.status='active' and u.role in ('owner','admin','agent')
  and u.product_role not in ('viewer','external_partner')
  and i.credential_state='active' and i.disabled_at is null
  and not w.is_qa
  and w.name !~* '(^|[[:space:]_-])(synthetic|qa)([[:space:]_-]|$)'
  and u.name !~* '(^|[[:space:]_-])(synthetic|qa)([[:space:]_-]|$)'
  and u.email !~* '(@|[.])(invalid|test|localhost)$|@example[.](com|net|org)$'
  and coalesce(c.account_label,'') !~* 'synthetic|@[^@]*[.](invalid|test)$'
  and c.account_id !~* '^synthetic[-_:]' and c.write_calendar_id !~* '^synthetic[-_:]'
  and exists(select 1 from public.workspace_module_settings m
    where m.workspace_id=p_workspace and m.module_key='calendar' and m.enabled)
  and (case when p_provider='google' then c.scopes && array[
    'https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/calendar.events']::text[]
    else exists(select 1 from unnest(c.scopes) s where lower(replace(s,'https://graph.microsoft.com/',''))='calendars.readwrite') end)
  and exists(select 1 from jsonb_array_elements(c.calendars) k
    where k->>'id'=p_calendar and k->'canRead'='true'::jsonb and k->'canWrite'='true'::jsonb
    and k->'protectedReadOnly'='false'::jsonb
    and not (lower(coalesce(k->>'name','')) like '%sekretariat%'
      and lower(coalesce(k->>'name','')) like '%grasl%' and lower(coalesce(k->>'name','')) like '%immobilien%'))
  and not exists(select 1 from unnest(c.conflict_calendar_ids) conflict_id where not exists(
    select 1 from jsonb_array_elements(c.calendars) k where k->>'id'=conflict_id and k->'canRead'='true'::jsonb))
 )
$$;
revoke all on function public.booking_production_connection_eligible(uuid,uuid,uuid,text,text,text)
 from public,novalure_app,novalure_tenant_app;

-- Only the protected schema administrator can explicitly approve or revoke an
-- exact resource. There is deliberately no EXECUTE grant to the application.
create function public.booking_admin_activate_production(p_activation uuid,p_workspace uuid,p_user uuid,
 p_provider text,p_connection uuid,p_account text,p_calendar text,p_origin text,
 p_capabilities text[],p_activated_at timestamptz,p_audience text,p_review_reference text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare result uuid;
begin
 if p_activation is null or p_activated_at is null or p_activated_at>now()
   or not public.booking_production_connection_eligible(p_workspace,p_user,p_connection,p_provider,p_account,p_calendar)
 then raise exception using errcode='42501',message='Production booking resource is not eligible'; end if;
 insert into public.booking_production_activations(activation_id,workspace_id,user_id,provider,
   connection_id,account_id,calendar_id,production_origin,capabilities,activated_at,audience,review_reference)
 values(p_activation,p_workspace,p_user,p_provider,p_connection,p_account,p_calendar,p_origin,
   p_capabilities,p_activated_at,p_audience,p_review_reference)
 on conflict(activation_id,workspace_id,user_id,provider) do update set connection_id=excluded.connection_id,
   account_id=excluded.account_id,calendar_id=excluded.calendar_id,production_origin=excluded.production_origin,
   capabilities=excluded.capabilities,activated_at=excluded.activated_at,audience=excluded.audience,
   review_reference=excluded.review_reference,status='active',updated_at=now()
 returning id into result;
 return result;
end $$;
revoke all on function public.booking_admin_activate_production(uuid,uuid,uuid,text,uuid,text,text,text,text[],timestamptz,text,text)
 from public,novalure_app,novalure_tenant_app;

create function public.booking_admin_revoke_production(p_id uuid,p_review_reference text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.booking_production_activations set status='revoked',review_reference=p_review_reference,updated_at=now()
 where id=p_id;
end $$;
revoke all on function public.booking_admin_revoke_production(uuid,text) from public,novalure_app,novalure_tenant_app;

create function public.booking_get_production_activation(p_activation uuid,p_workspace uuid,p_user uuid,
 p_provider text,p_connection uuid,p_account text,p_calendar text,p_origin text,p_capability text)
returns table("workspaceId" uuid,"userId" uuid,provider text,"connectionId" uuid,"accountId" text,
 "calendarId" text,"activationId" uuid,"activatedAt" timestamptz,audience text)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not coalesce(public.booking_actor_allowed(p_workspace,p_user),false) then return; end if;
 return query select a.workspace_id,a.user_id,a.provider,a.connection_id,a.account_id,a.calendar_id,
   a.activation_id,a.activated_at,a.audience
 from public.booking_production_activations a
 where a.activation_id=p_activation and a.workspace_id=p_workspace and a.user_id=p_user
 and a.provider=p_provider and a.connection_id=p_connection and a.account_id=p_account and a.calendar_id=p_calendar
 and a.production_origin=p_origin and a.status='active' and a.activated_at<=now()
 and p_capability in ('booking','messages') and p_capability=any(a.capabilities)
 and public.booking_production_connection_eligible(a.workspace_id,a.user_id,a.connection_id,a.provider,a.account_id,a.calendar_id)
 for share of a;
end $$;
revoke all on function public.booking_get_production_activation(uuid,uuid,uuid,text,uuid,text,text,text,text) from public;
grant execute on function public.booking_get_production_activation(uuid,uuid,uuid,text,uuid,text,text,text,text) to novalure_tenant_app;

create function public.booking_list_production_activations(p_activation uuid,p_origin text,p_capability text,p_limit integer)
returns table("workspaceId" uuid,"userId" uuid,provider text,"connectionId" uuid,"accountId" text,
 "calendarId" text,"activationId" uuid,"activatedAt" timestamptz,audience text)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_limit is null or p_limit<1 or p_limit>1000 or p_capability not in ('booking','messages') then
   raise exception using errcode='22023',message='Invalid production registry bounds'; end if;
 return query select a.workspace_id,a.user_id,a.provider,a.connection_id,a.account_id,a.calendar_id,
   a.activation_id,a.activated_at,a.audience
 from public.booking_production_activations a
 where a.activation_id=p_activation and a.production_origin=p_origin and a.status='active'
 and a.activated_at<=now() and p_capability=any(a.capabilities)
 and public.booking_production_connection_eligible(a.workspace_id,a.user_id,a.connection_id,a.provider,a.account_id,a.calendar_id)
 order by a.workspace_id,a.user_id,a.provider limit p_limit;
end $$;
revoke all on function public.booking_list_production_activations(uuid,text,text,integer) from public;
grant execute on function public.booking_list_production_activations(uuid,text,text,integer) to novalure_tenant_app;
