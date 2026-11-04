-- Manager-visible integration checks are local diagnostics, never provider delivery evidence.
set local lock_timeout='5s';
create table crm_integration_checks(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),project_id uuid,
 target_type text not null check(target_type in('calendar','website','resend')),target_id text not null check(length(target_id) between 1 and 100),
 mode text not null default 'local' check(mode='local'),passed boolean not null,checks jsonb not null check(jsonb_typeof(checks)='array'),created_by uuid not null,created_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
alter table crm_integration_checks enable row level security;alter table crm_integration_checks force row level security;
create trigger integration_check_classification before insert on crm_integration_checks for each row execute function crm_set_sales_classification();
create policy integration_check_scope on crm_integration_checks to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id) and created_by=nullif(current_setting('app.actor_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on crm_integration_checks from public,novalure_app;grant select,insert on crm_integration_checks to novalure_tenant_app;
create trigger integration_checks_immutable before update or delete or truncate on crm_integration_checks for each statement execute function crm_reject_immutable_mutation();

-- Reuse the existing encrypted provider model without granting raw credential-table access.
create function crm_integrations_calendar_status(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 perform crm_operational_assert_scope(p_workspace,null,null,'calendar:sync');
 if not crm_workspace_manager(p_workspace) then raise exception using errcode='42501',message='Integration management denied';end if;
 select jsonb_object_agg(v.provider,jsonb_build_object('provider',v.provider,'accountLabel',c.account_label,'status',coalesce(c.status,'not_configured'),'connected',coalesce(c.status='connected',false),'expiresAt',c.expires_at,'scopes',coalesce(c.scopes,'{}'::text[]),'updatedAt',c.updated_at,'error',case when nullif(c.error,'') is not null then 'connection_requires_attention' end)) into result from(values('google','google-calendar'),('microsoft','microsoft-calendar')) v(provider,key) left join provider_connections c on c.workspace_id=p_workspace and c.provider=v.key;
 return result;
end $$;
revoke all on function crm_integrations_calendar_status(uuid) from public,novalure_app;grant execute on function crm_integrations_calendar_status(uuid) to novalure_tenant_app;
create function crm_integrations_disconnect_calendar(p_workspace uuid,p_provider text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare changed boolean;begin
 perform crm_operational_assert_scope(p_workspace,null,null,'calendar:sync');
 if not crm_workspace_manager(p_workspace) or p_provider not in('google','microsoft') then raise exception using errcode='42501',message='Integration management denied';end if;
 update provider_connections set status='disconnected',config='{}',scopes='{}',expires_at=null,refreshed_at=null,error=null,updated_at=clock_timestamp() where workspace_id=p_workspace and provider=p_provider||'-calendar';
 changed:=found;return changed;
end $$;
revoke all on function crm_integrations_disconnect_calendar(uuid,text) from public,novalure_app;grant execute on function crm_integrations_disconnect_calendar(uuid,text) to novalure_tenant_app;

-- A revoked publishable site identifier is terminal. New registration uses the existing bounded gateway model.
create function crm_integrations_terminal_revocation() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin if old.status='revoked' and(new.status<>'revoked' or new.revoked_at is distinct from old.revoked_at) then raise exception using errcode='23514',message='A revoked integration cannot be reactivated';end if;return new;end $$;
do $$ begin if to_regclass('public.external_integrations') is not null then create trigger integration_terminal_revocation before update on external_integrations for each row execute function crm_integrations_terminal_revocation();end if;end $$;
revoke all on function crm_integrations_terminal_revocation() from public;

-- Verified provider events are separate immutable evidence. They never rewrite a send claim.
create table crm_provider_delivery_events(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),project_id uuid,
 provider text not null default 'resend' check(provider='resend'),event_key text not null unique check(length(event_key) between 8 and 160),event_digest text not null check(event_digest~'^[a-f0-9]{64}$'),
 delivery_kind text not null check(delivery_kind in('newsletter','newsletter_test','automation')),delivery_id uuid not null,provider_email_id uuid not null,
 event_type text not null check(event_type in('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed')),
 occurred_at timestamptz not null,received_at timestamptz not null default now(),bounce_type text check(bounce_type in('Permanent','Transient','Undetermined')),
 data_classification text not null check(data_classification in('CUSTOMER_TENANT','NOVALURE_INTERNAL')),data_purpose text not null default 'crm_sales' check(data_purpose='crm_sales'),
 foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
create index provider_delivery_events_target on crm_provider_delivery_events(workspace_id,delivery_kind,delivery_id,occurred_at);
create index newsletter_provider_message_lookup on crm_newsletter_deliveries(lower(provider_message_id)) where provider_message_id is not null;
create index newsletter_test_provider_message_lookup on crm_newsletter_test_sends(lower(provider_message_id)) where provider_message_id is not null;
create index automation_provider_message_lookup on crm_automation_mail_deliveries(lower(provider_message_id)) where provider_message_id is not null;
alter table crm_provider_delivery_events enable row level security;alter table crm_provider_delivery_events force row level security;
create policy provider_delivery_events_read on crm_provider_delivery_events for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and(case when project_id is null then crm_workspace_manager(workspace_id) else crm_project_access(workspace_id,project_id,false) end));
create policy provider_delivery_events_owner on crm_provider_delivery_events using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.crm_provider_delivery_events'::regclass))) with check(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.crm_provider_delivery_events'::regclass)));
revoke all on crm_provider_delivery_events from public,novalure_app,novalure_tenant_app;grant select on crm_provider_delivery_events to novalure_tenant_app;
create trigger provider_delivery_events_immutable before update or delete or truncate on crm_provider_delivery_events for each statement execute function crm_reject_immutable_mutation();
alter table newsletter_suppressions drop constraint newsletter_suppressions_reason_check;
alter table newsletter_suppressions add constraint newsletter_suppressions_reason_check check(reason in('unsubscribe','bounce','complaint','manual','provider_suppression'));

-- Public narrow definer functions also work for a non-BYPASS table owner under FORCE RLS.
-- The tenant runtime cannot assume these owner roles (checked by the tenant transaction boundary).
do $$ declare t text;begin
 foreach t in array array['crm_newsletter_deliveries','crm_newsletter_test_sends','crm_automation_mail_deliveries','crm_newsletter_versions'] loop
  execute format('create policy provider_event_source_owner on %I for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
 end loop;
 foreach t in array array['newsletter_suppressions','consent_records'] loop
  execute format('create policy provider_event_insert_owner on %I for insert with check(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
  execute format('create policy provider_event_side_effect_owner_read on %I for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
 end loop;
end $$;

create function crm_record_resend_delivery_event(p_event jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare source record;matches integer;prior text;sender text;recipient text;ref_kind text;ref_id uuid;email_id uuid;event_type text;event_key text;digest text;occurred timestamptz;bounce text;
begin
 -- Only the server signature-verification adapter may call this narrow sink. Scope is derived from a real send snapshot.
 event_type:=p_event->>'type';event_key:=p_event->>'eventId';digest:=p_event->>'digest';
 if event_type not in('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed') or length(event_key) not between 8 and 160 or digest!~'^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Invalid provider event';end if;
 email_id:=(p_event->>'emailId')::uuid;occurred:=(p_event->>'occurredAt')::timestamptz;recipient:=lower(p_event->>'to');sender:=lower(p_event->>'from');bounce:=p_event->>'bounceType';ref_kind:=p_event#>>'{reference,kind}';
 if ref_kind is not null then if ref_kind not in('newsletter','newsletter_test','automation') then return '{"status":"ignored"}';end if;ref_id:=(p_event#>>'{reference,id}')::uuid;end if;
 perform pg_advisory_xact_lock(hashtextextended('resend-event:'||event_key,0));
 select e.event_digest into prior from crm_provider_delivery_events e where e.provider='resend' and e.event_key=p_event->>'eventId';
 if found then return jsonb_build_object('status',case when prior=digest then 'duplicate' else 'conflict' end);end if;
 with candidates as(
  select 'newsletter'::text as kind,id,workspace_id,project_id,contact_id,to_email,payload,provider_message_id,status,data_classification,data_purpose from crm_newsletter_deliveries
  union all select 'newsletter_test',id,workspace_id,project_id,null::uuid,to_email,payload,provider_message_id,status,data_classification,data_purpose from crm_newsletter_test_sends
  union all select 'automation',id,workspace_id,project_id,contact_id,payload->>'to',payload,provider_message_id,status,data_classification,data_purpose from crm_automation_mail_deliveries
 ) select count(*) into matches from candidates c where c.status in('claimed','accepted','uncertain','failed') and(case when ref_kind is null then lower(c.provider_message_id)=email_id::text else c.kind=ref_kind and c.id=ref_id and(c.provider_message_id is null or lower(c.provider_message_id)=email_id::text) end);
 if matches<>1 then return '{"status":"ignored"}';end if;
 with candidates as(
  select 'newsletter'::text as kind,id,workspace_id,project_id,contact_id,to_email,payload,provider_message_id,status,data_classification,data_purpose from crm_newsletter_deliveries
  union all select 'newsletter_test',id,workspace_id,project_id,null::uuid,to_email,payload,provider_message_id,status,data_classification,data_purpose from crm_newsletter_test_sends
  union all select 'automation',id,workspace_id,project_id,contact_id,payload->>'to',payload,provider_message_id,status,data_classification,data_purpose from crm_automation_mail_deliveries
 ) select * into source from candidates c where c.status in('claimed','accepted','uncertain','failed') and(case when ref_kind is null then lower(c.provider_message_id)=email_id::text else c.kind=ref_kind and c.id=ref_id and(c.provider_message_id is null or lower(c.provider_message_id)=email_id::text) end);
 if source.to_email<>recipient or lower(trim(coalesce(substring(source.payload->>'from' from '<([^<>]+)>'),source.payload->>'from')))<>sender or source.data_classification not in('CUSTOMER_TENANT','NOVALURE_INTERNAL') or source.data_purpose<>'crm_sales' then return '{"status":"ignored"}';end if;
 perform pg_advisory_xact_lock(hashtextextended('resend-delivery:'||source.kind||':'||source.id::text,0));
 -- A different email ID for the same immutable target cannot silently replace earlier provider evidence.
 if exists(select 1 from crm_provider_delivery_events e where e.workspace_id=source.workspace_id and e.delivery_kind=source.kind and e.delivery_id=source.id and e.provider_email_id<>email_id) then return '{"status":"conflict"}';end if;
 insert into crm_provider_delivery_events(workspace_id,project_id,event_key,event_digest,delivery_kind,delivery_id,provider_email_id,event_type,occurred_at,bounce_type,data_classification,data_purpose)
 values(source.workspace_id,source.project_id,event_key,digest,source.kind,source.id,email_id,event_type,occurred,bounce,source.data_classification,source.data_purpose);
 if source.kind<>'newsletter_test' and(event_type in('email.complained','email.suppressed') or(event_type='email.bounced' and coalesce(bounce,'Permanent')='Permanent')) then
  insert into newsletter_suppressions(workspace_id,email,reason,source,metadata,data_classification,data_purpose)
  values(source.workspace_id,source.to_email,case when event_type='email.complained' then 'complaint' when event_type='email.bounced' then 'bounce' else 'provider_suppression' end,'Signed Resend webhook',jsonb_build_object('providerEventId',event_key,'deliveryId',source.id),source.data_classification,source.data_purpose) on conflict(workspace_id,lower(email)) do nothing;
 end if;
 return '{"status":"recorded"}';
end $$;
revoke all on function crm_record_resend_delivery_event(jsonb) from public;
grant execute on function crm_record_resend_delivery_event(jsonb) to novalure_app;
