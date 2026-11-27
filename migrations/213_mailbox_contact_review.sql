-- Personal review suggestions for visible, project-scoped contacts without a lead.
-- Existing lead linkage and private mailbox permissions remain unchanged.
alter table public.crm_mailbox_auto_settings add column contact_review_enabled boolean not null default false;
alter table public.crm_mailbox_auto_settings add column contact_review_backfill_pending boolean not null default false;
alter table public.crm_mailbox_auto_settings add column contact_review_backfill_resume jsonb check(contact_review_backfill_resume is null or (jsonb_typeof(contact_review_backfill_resume)='object' and octet_length(contact_review_backfill_resume::text)<=1572864));
alter table public.crm_mailbox_auto_settings add column contact_review_backfill_replaying boolean not null default false;
-- A cursor reset is incomplete until all stored messages have been checked
-- against the provider and a fresh delta cursor has replayed concurrent changes.
create table public.crm_mailbox_cursor_recovery (
 workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,
 phase text not null check(phase in ('baseline','verify','replay')),
 ceiling_id uuid,last_id uuid,baseline_checkpoint jsonb,
 updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id,connection_id),
 foreign key(workspace_id,user_id,connection_id) references public.crm_mailbox_connections(workspace_id,user_id,id),
 check(baseline_checkpoint is null or (jsonb_typeof(baseline_checkpoint)='object' and octet_length(baseline_checkpoint::text)<=1572864))
);
alter table public.crm_mailbox_cursor_recovery enable row level security;
alter table public.crm_mailbox_cursor_recovery force row level security;
create policy mailbox_personal on public.crm_mailbox_cursor_recovery for all to novalure_tenant_app
 using(crm_mailbox_actor(workspace_id,user_id)) with check(crm_mailbox_actor(workspace_id,user_id));
grant select,insert,update,delete on public.crm_mailbox_cursor_recovery to novalure_tenant_app;
create function public.crm_mailbox_contact_review_guard_ready() returns boolean
language sql immutable set search_path=pg_catalog,public as $$ select true $$;
revoke all on function public.crm_mailbox_contact_review_guard_ready() from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_mailbox_contact_review_guard_ready() to novalure_tenant_app;

create or replace function public.crm_mailbox_private_decision_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.lead_id is not null and(not crm_project_access(new.workspace_id,new.project_id,false) or not exists(select 1 from leads l where l.workspace_id=new.workspace_id and l.project_id=new.project_id and l.id=new.lead_id and l.contact_id=new.contact_id)) then
  raise exception using errcode='42501',message='Current personally readable lead/contact required';
 end if;
 if new.contact_id is not null and new.lead_id is null then
  if new.status <> 'review' or new.message_id is null or new.reason <> 'exact_address_unique_contact_unverified_sender' or new.project_id is null or not exists(
   select 1 from contacts c join projects p on p.workspace_id=c.workspace_id and p.id=c.project_id
   where c.workspace_id=new.workspace_id and c.id=new.contact_id and c.project_id=new.project_id and c.archived_at is null
    and crm_project_access(c.workspace_id,c.project_id,false)
    and crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose)
    and crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
    and exists(select 1 from crm_mailbox_messages m where m.workspace_id=new.workspace_id and m.user_id=new.user_id and m.id=new.message_id and m.deleted_at is null and m.from_address=lower(btrim(c.email)))
    and (select count(*) from contacts candidate join projects cp on cp.workspace_id=candidate.workspace_id and cp.id=candidate.project_id
      where candidate.workspace_id=new.workspace_id and candidate.project_id is not null and candidate.archived_at is null and lower(btrim(candidate.email))=lower(btrim(c.email))
       and crm_project_access(candidate.workspace_id,candidate.project_id,false)
       and crm_classification_allowed(candidate.workspace_id,candidate.data_classification,candidate.data_purpose)
       and crm_classification_allowed(cp.workspace_id,cp.data_classification,cp.data_purpose))=1
  ) then raise exception using errcode='42501',message='Currently readable project contact review required'; end if;
 end if;
 return new;
end $$;
revoke all on function public.crm_mailbox_private_decision_guard() from public,novalure_app,novalure_tenant_app;
