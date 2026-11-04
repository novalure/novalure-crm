-- A deliberate, single-recipient send records its claim before crossing the provider boundary.
set local lock_timeout='5s';
create table public.crm_automation_mail_deliveries (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid,
 draft_id uuid not null,contact_id uuid not null,actor_id uuid not null,
 purpose text not null check(purpose in('salesFollowUp','meetingFollowUp')),
 approval_digest text not null check(approval_digest~'^[a-f0-9]{64}$'),payload jsonb not null check(jsonb_typeof(payload)='object'),
 status text not null default 'claimed' check(status in('claimed','accepted','failed','uncertain','suppressed')),
 provider_message_id text,error text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),accepted_at timestamptz,
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 unique(workspace_id,id),unique(workspace_id,draft_id),
 foreign key(workspace_id,draft_id) references crm_automation_drafts(workspace_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 check(status<>'accepted' or nullif(provider_message_id,'') is not null)
);
create function public.crm_automation_mail_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare d crm_automation_drafts;begin
 if tg_op='UPDATE' then
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.draft_id is distinct from old.draft_id or new.contact_id is distinct from old.contact_id or new.actor_id is distinct from old.actor_id or new.purpose is distinct from old.purpose or new.approval_digest is distinct from old.approval_digest or new.payload is distinct from old.payload or new.created_at is distinct from old.created_at then raise exception using errcode='23514',message='Mail approval snapshot is immutable';end if;
  if old.status<>'claimed' and new is distinct from old then raise exception using errcode='23514',message='Mail results cannot be retried or rewritten';end if;
 else
  select * into d from crm_automation_drafts where workspace_id=new.workspace_id and id=new.draft_id;
  if not found or d.project_id is distinct from new.project_id or d.contact_id is distinct from new.contact_id or d.status<>'pending' then raise exception using errcode='23514',message='Mail draft scope mismatch';end if;
 end if;return new;
end $$;
create trigger mail_snapshot_guard before insert or update on crm_automation_mail_deliveries for each row execute function crm_automation_mail_guard();
create trigger crm_sales_classification_guard before insert or update on crm_automation_mail_deliveries for each row execute function crm_set_sales_classification();
alter table crm_automation_mail_deliveries enable row level security;
alter table crm_automation_mail_deliveries force row level security;
create policy mail_scope on crm_automation_mail_deliveries to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and (case when project_id is null then crm_workspace_manager(workspace_id) else crm_project_access(workspace_id,project_id,false) end)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and (case when project_id is null then crm_workspace_manager(workspace_id) else crm_project_access(workspace_id,project_id,true) end));
revoke all on crm_automation_mail_deliveries from public,novalure_app;
grant select,insert,update on crm_automation_mail_deliveries to novalure_tenant_app;
-- Review cannot continue a run whose external result is still unknown.
create function public.crm_automation_draft_mail_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare erase_allowed boolean:=false;begin
 if new.subject='Gelöschter Automationsentwurf' and new.body='' and new.contact_id is null and new.status='dismissed' and to_regprocedure('public.crm_automation_erasure_owner()') is not null then
  execute 'select public.crm_automation_erasure_owner()' into erase_allowed;
  if erase_allowed then return new;end if;
 end if;
 if exists(select 1 from crm_automation_mail_deliveries m where m.workspace_id=old.workspace_id and m.draft_id=old.id and (m.status in('claimed','uncertain') or new.subject is distinct from old.subject or new.body is distinct from old.body or new.contact_id is distinct from old.contact_id or new.enrollment_id is distinct from old.enrollment_id or new.node_id is distinct from old.node_id)) then raise exception using errcode='23514',message='Mail send is unresolved or its approved snapshot is immutable';end if;
 return new;
end $$;
create trigger draft_mail_guard before update on crm_automation_drafts for each row execute function crm_automation_draft_mail_guard();
revoke all on function public.crm_automation_mail_guard(),public.crm_automation_draft_mail_guard() from public;
