-- Manual personal work state. This never asserts that an email was sent.
create table crm_mailbox_triage (
 workspace_id uuid not null,user_id uuid not null,message_id uuid not null,
 status text not null check(status in('needs_reply','waiting','done')),revision integer not null default 1 check(revision>0),updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id,message_id),foreign key(workspace_id,user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id)
);
create table crm_mailbox_triage_history (
 workspace_id uuid not null,user_id uuid not null,message_id uuid not null,revision integer not null,status text not null check(status in('needs_reply','waiting','done')),changed_at timestamptz not null default now(),
 primary key(workspace_id,user_id,message_id,revision),foreign key(workspace_id,user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id)
);
alter table crm_mailbox_triage enable row level security;
alter table crm_mailbox_triage force row level security;
alter table crm_mailbox_triage_history enable row level security;
alter table crm_mailbox_triage_history force row level security;
create policy personal_triage_scope on crm_mailbox_triage for all to novalure_tenant_app using(crm_mailbox_actor(workspace_id,user_id)) with check(crm_mailbox_actor(workspace_id,user_id));
create policy personal_triage_history_read on crm_mailbox_triage_history for select to novalure_tenant_app using(crm_mailbox_actor(workspace_id,user_id));
create policy personal_triage_history_insert on crm_mailbox_triage_history for insert to novalure_tenant_app with check(crm_mailbox_actor(workspace_id,user_id));
grant select,insert,update on crm_mailbox_triage to novalure_tenant_app;
grant select,insert on crm_mailbox_triage_history to novalure_tenant_app;
create function crm_mailbox_triage_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_mailbox_actor(new.workspace_id,new.user_id) or not exists(select 1 from crm_mailbox_messages m where m.workspace_id=new.workspace_id and m.user_id=new.user_id and m.id=new.message_id and m.deleted_at is null) then raise exception using errcode='42501',message='Own current personal message required'; end if;
 if exists(select 1 from crm_mailbox_links l where l.workspace_id=new.workspace_id and l.user_id=new.user_id and l.message_id=new.message_id)
 and not exists(select 1 from crm_mailbox_links l join leads lead on lead.id=l.lead_id and lead.workspace_id=l.workspace_id and lead.project_id=l.project_id where l.workspace_id=new.workspace_id and l.user_id=new.user_id and l.message_id=new.message_id and crm_project_access(l.workspace_id,l.project_id,true)) then raise exception using errcode='42501',message='Current linked lead permission required'; end if;
 if tg_op='INSERT' and new.revision<>1 then raise exception using errcode='23514',message='Initial triage revision must be one'; end if;
 if tg_op='UPDATE' and(new.workspace_id<>old.workspace_id or new.user_id<>old.user_id or new.message_id<>old.message_id or new.revision<>old.revision+1) then raise exception using errcode='23514',message='Triage identity is immutable and revision must advance'; end if;
 return new;
end $$;
create trigger personal_triage_guard before insert or update on crm_mailbox_triage for each row execute function crm_mailbox_triage_guard();
create function crm_mailbox_triage_history_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from crm_mailbox_triage t where t.workspace_id=new.workspace_id and t.user_id=new.user_id and t.message_id=new.message_id and t.revision=new.revision and t.status=new.status) then raise exception using errcode='23514',message='Exact committed personal triage state required'; end if;
 return new;
end $$;
create trigger personal_triage_history_guard before insert on crm_mailbox_triage_history for each row execute function crm_mailbox_triage_history_guard();
create function crm_mailbox_triage_audit() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 insert into crm_mailbox_triage_history(workspace_id,user_id,message_id,revision,status) values(new.workspace_id,new.user_id,new.message_id,new.revision,new.status);
 return new;
end $$;
create trigger personal_triage_audit after insert or update on crm_mailbox_triage for each row execute function crm_mailbox_triage_audit();
revoke all on function crm_mailbox_triage_guard(),crm_mailbox_triage_history_guard(),crm_mailbox_triage_audit() from public;
