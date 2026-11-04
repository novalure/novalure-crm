-- Shared, deliberately opt-in contact windows and rate limits. No send delegation.
set local lock_timeout='5s';
create table crm_marketing_contact_policy (
 workspace_id uuid primary key references workspaces(id),revision integer not null default 1 check(revision>0),
 rules jsonb not null check(jsonb_typeof(rules)='object'),updated_by uuid not null,updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',
 foreign key(workspace_id,updated_by) references workspace_users(workspace_id,id)
);
create function crm_marketing_contact_policy_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_workspace_manager(new.workspace_id) or new.updated_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='42501',message='Contact policy manager required';end if;
 if (tg_op='INSERT' and new.revision<>1) or(tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.revision<>old.revision+1)) then raise exception using errcode='23514',message='Contact policy revision conflict';end if;
 return new;
end $$;
create trigger contact_policy_classification before insert or update on crm_marketing_contact_policy for each row execute function crm_set_sales_classification();
create trigger contact_policy_guard before insert or update on crm_marketing_contact_policy for each row execute function crm_marketing_contact_policy_guard();
alter table crm_marketing_contact_policy enable row level security;
alter table crm_marketing_contact_policy force row level security;
create policy contact_policy_read on crm_marketing_contact_policy for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and exists(select 1 from workspace_users u where u.workspace_id=crm_marketing_contact_policy.workspace_id and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active'));
create policy contact_policy_write on crm_marketing_contact_policy for all to novalure_tenant_app using(crm_workspace_manager(workspace_id) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_workspace_manager(workspace_id) and crm_classification_allowed(workspace_id,data_classification,data_purpose));
revoke all on crm_marketing_contact_policy from public;
grant select,insert,update on crm_marketing_contact_policy to novalure_tenant_app;

-- Only a provably pre-provider deferral may be claimed again with fresh explicit approval.
-- Accepted, uncertain and failed provider attempts remain immutable and are never retried here.
do $migration$ begin
 if to_regclass('public.crm_automation_mail_deliveries') is not null then
  alter table crm_automation_mail_deliveries drop constraint crm_automation_mail_deliveries_status_check;
  alter table crm_automation_mail_deliveries add constraint crm_automation_mail_deliveries_status_check check(status in('claimed','accepted','failed','uncertain','suppressed','deferred'));
  execute $definition$
  create or replace function public.crm_automation_mail_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $guard$
  declare d crm_automation_drafts;begin
   if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id or new.project_id is distinct from old.project_id or new.draft_id is distinct from old.draft_id or new.contact_id is distinct from old.contact_id or new.actor_id is distinct from old.actor_id or new.purpose is distinct from old.purpose or new.approval_digest is distinct from old.approval_digest or new.payload is distinct from old.payload or new.created_at is distinct from old.created_at then raise exception using errcode='23514',message='Mail approval snapshot is immutable';end if;
    if old.status='deferred' and new.status='claimed' and old.error like 'CONTACT_POLICY_DEFERRED:%' and old.provider_message_id is null and old.accepted_at is null and new.provider_message_id is null and new.accepted_at is null and new.error is null and new.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid then
     select * into d from crm_automation_drafts where workspace_id=new.workspace_id and id=new.draft_id;
     if not found or d.status<>'pending' or d.contact_id is distinct from new.contact_id then raise exception using errcode='23514',message='Deferred draft is no longer pending';end if;
     return new;
    end if;
    if old.status<>'claimed' and new is distinct from old then raise exception using errcode='23514',message='Mail provider results cannot be retried or rewritten';end if;
    if new.status='deferred' and (new.error not like 'CONTACT_POLICY_DEFERRED:%' or new.error is null or old.provider_message_id is not null or old.accepted_at is not null or new.provider_message_id is not null or new.accepted_at is not null) then raise exception using errcode='23514',message='Only a pre-provider contact policy deferral is resumable';end if;
   else
    select * into d from crm_automation_drafts where workspace_id=new.workspace_id and id=new.draft_id;
    if not found or d.project_id is distinct from new.project_id or d.contact_id is distinct from new.contact_id or d.status<>'pending' or new.status<>'claimed' then raise exception using errcode='23514',message='Mail draft scope mismatch';end if;
   end if;return new;
  end $guard$;
  $definition$;
 end if;
end $migration$;
