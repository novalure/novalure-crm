-- Saved mailing revisions, explicit approval and durable per-recipient dispatch records.
set local lock_timeout='5s';
create table public.crm_newsletter_drafts (
 workspace_id uuid not null references workspaces(id), project_id uuid not null,
 campaign_id uuid primary key references newsletter_campaigns(id), revision integer not null default 1 check(revision>0),
 input jsonb not null check(jsonb_typeof(input)='object'), approved_revision integer,
 updated_by uuid not null, updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create table public.crm_newsletter_versions (
 workspace_id uuid not null,project_id uuid not null,campaign_id uuid not null references newsletter_campaigns(id),revision integer not null,
 input jsonb not null,content_digest text not null check(content_digest~'^[0-9a-f]{64}$'),
 approved_by uuid not null,approved_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 primary key(workspace_id,campaign_id,revision),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,approved_by) references workspace_users(workspace_id,id)
);
create table public.crm_newsletter_deliveries (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,
 campaign_id uuid not null,revision integer not null,contact_id uuid not null,to_email text not null check(to_email=lower(to_email)),
 status text not null default 'pending' check(status in('pending','claimed','accepted','failed','uncertain','suppressed','cancelled')),
 payload jsonb not null check(jsonb_typeof(payload)='object'),unsubscribe_token_hash text not null unique check(unsubscribe_token_hash~'^[0-9a-f]{64}$'),
 claimed_by uuid,claimed_at timestamptz,provider_message_id text,error text,accepted_at timestamptz,unsubscribed_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,campaign_id,revision,to_email),
 foreign key(workspace_id,campaign_id,revision) references crm_newsletter_versions(workspace_id,campaign_id,revision),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
create index crm_newsletter_pending on crm_newsletter_deliveries(workspace_id,campaign_id,revision,status);
create table public.crm_newsletter_test_sends (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,campaign_id uuid not null references newsletter_campaigns(id),revision integer not null,
 actor_id uuid not null,to_email text not null,input_digest text not null,payload jsonb not null,
 status text not null check(status in('claimed','accepted','failed','uncertain','cancelled')),
 provider_message_id text,error text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id)
);
create function public.crm_newsletter_scope_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare campaign_project uuid;campaign_workspace uuid;customer_project uuid;begin
 if tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.campaign_id is distinct from old.campaign_id) then raise exception using errcode='23514',message='Newsletter scope is immutable';end if;
 if tg_op='UPDATE' and tg_table_name='crm_newsletter_deliveries' then
 if new.contact_id is distinct from old.contact_id or new.to_email is distinct from old.to_email or new.revision is distinct from old.revision or new.payload is distinct from old.payload or new.unsubscribe_token_hash is distinct from old.unsubscribe_token_hash then raise exception using errcode='23514',message='Newsletter approved delivery is immutable';end if;
 return new;
 end if;
 if tg_op='UPDATE' and tg_table_name='crm_newsletter_test_sends' then
 if new.actor_id is distinct from old.actor_id or new.to_email is distinct from old.to_email or new.revision is distinct from old.revision or new.payload is distinct from old.payload or new.input_digest is distinct from old.input_digest then raise exception using errcode='23514',message='Newsletter test snapshot is immutable';end if;
 return new;end if;
 select c.workspace_id,c.project_id into campaign_workspace,campaign_project from newsletter_campaigns c where c.id=new.campaign_id;
 if campaign_workspace is distinct from new.workspace_id or campaign_project is distinct from new.project_id then raise exception using errcode='23514',message='Newsletter campaign scope mismatch';end if;
 if tg_table_name='crm_newsletter_deliveries' then
 select c.project_id into customer_project from contacts c where c.id=new.contact_id and c.workspace_id=new.workspace_id;
 if not found or customer_project is distinct from new.project_id then raise exception using errcode='23514',message='Newsletter recipient scope mismatch';end if;
 end if;return new;end $$;
do $$ declare relation text;begin
 foreach relation in array array['crm_newsletter_drafts','crm_newsletter_versions','crm_newsletter_deliveries','crm_newsletter_test_sends'] loop
 execute format('alter table %I enable row level security',relation);
 execute format('alter table %I force row level security',relation);
 execute format('create trigger newsletter_classification before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
 execute format('create trigger newsletter_scope before insert or update on %I for each row execute function crm_newsletter_scope_guard()',relation);
 execute format('create policy newsletter_read on %I for select to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false))',relation);
 execute format('create policy newsletter_write on %I for all to novalure_tenant_app using(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true)) with check(crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
 execute format('revoke all on %I from public',relation);
 execute format('grant select,insert on %I to novalure_tenant_app',relation);
 end loop;end $$;
grant update on crm_newsletter_drafts,crm_newsletter_deliveries,crm_newsletter_test_sends to novalure_tenant_app;
create trigger newsletter_version_immutable before update or delete or truncate on crm_newsletter_versions for each statement execute function crm_reject_immutable_mutation();

-- Possession of a 256-bit per-delivery capability permits only marketing opt-out.
-- GET checks the capability; only the separate POST function changes preferences.
create function public.crm_newsletter_public_check(p_hash text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('valid',true,'unsubscribed',d.unsubscribed_at is not null,'language',coalesce(v.input->>'language','en'))
 from crm_newsletter_deliveries d join crm_newsletter_versions v on v.workspace_id=d.workspace_id and v.campaign_id=d.campaign_id and v.revision=d.revision
 where d.unsubscribe_token_hash=p_hash and p_hash~'^[0-9a-f]{64}$'
$$;
create function public.crm_newsletter_public_unsubscribe(p_hash text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare delivery crm_newsletter_deliveries;begin
 if coalesce(p_hash,'')!~'^[0-9a-f]{64}$' then return false;end if;
 select * into delivery from crm_newsletter_deliveries where unsubscribe_token_hash=p_hash for update;
 if not found then return false;end if;
 if delivery.unsubscribed_at is not null then return true;end if;
 insert into newsletter_suppressions(workspace_id,campaign_id,email,reason,source,metadata)
 values(delivery.workspace_id,delivery.campaign_id,delivery.to_email,'unsubscribe','Newsletter capability',jsonb_build_object('deliveryId',delivery.id))
 on conflict(workspace_id,lower(email)) do nothing;
 insert into consent_records(workspace_id,project_id,contact_id,channel,status,source,metadata)
 values(delivery.workspace_id,delivery.project_id,delivery.contact_id,'Newsletter','Abgemeldet','Newsletter capability',jsonb_build_object('deliveryId',delivery.id));
 update crm_newsletter_deliveries set unsubscribed_at=now(),updated_at=now() where id=delivery.id;
 return true;end $$;
revoke all on function public.crm_newsletter_public_check(text),public.crm_newsletter_public_unsubscribe(text) from public;
grant execute on function public.crm_newsletter_public_check(text),public.crm_newsletter_public_unsubscribe(text) to novalure_tenant_app;
