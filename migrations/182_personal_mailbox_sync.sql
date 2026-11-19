-- Personal, opt-in background reading. No team mailbox, automatic reply event or mail sending.
alter table crm_mailbox_connections add column provider_account_id text;
alter table crm_mailbox_connections add column provider_id_format text not null default 'legacy' check(provider_id_format in('legacy','immutable'));
create unique index mailbox_provider_account_binding on crm_mailbox_connections(workspace_id,user_id,provider,provider_account_id) where provider_account_id is not null;
alter table crm_mailbox_messages add column provider_id_format text not null default 'legacy' check(provider_id_format in('legacy','immutable'));
alter table crm_mailbox_messages add column source_status text not null default 'in_inbox' check(source_status in('in_inbox','left_inbox','source_missing'));
alter table crm_mailbox_messages add column reply_headers jsonb not null default '{}' check(jsonb_typeof(reply_headers)='object');
create table crm_mailbox_auto_settings (
 workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,identity_id uuid not null references auth_identities(id),
 enabled boolean not null default false,auto_file boolean not null default false,folder text not null default 'inbox' check(folder='inbox'),
 revision integer not null default 1,activated_at timestamptz not null default now(),next_run_at timestamptz not null default now(),
 status text not null default 'not_initialized' check(status in('disabled','not_initialized','catching_up','current','delayed','review','reauthorization_required','identity_migration','disconnected')),
 last_success_at timestamptz,last_error text,failure_count integer not null default 0,updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id,connection_id),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id)
);
create table crm_mailbox_auto_checkpoints (
 workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,folder text not null default 'inbox' check(folder='inbox'),
 checkpoint jsonb not null check(jsonb_typeof(checkpoint)='object' and octet_length(checkpoint::text)<=1572864),updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id,connection_id,folder),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id)
);
create table crm_mailbox_id_aliases (
 workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,old_id text not null,immutable_id text not null,message_id uuid not null,
 primary key(connection_id,old_id),foreign key(workspace_id,user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id)
);
create table crm_mailbox_private_decisions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,provider_id text not null,
 message_id uuid,project_id uuid,lead_id uuid,contact_id uuid,
 status text not null check(status in('suggested','filed','review','ignored','quarantined','source_missing','left_inbox')),reason text not null,rule_version integer not null default 1,
 subject text not null default '',metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=16000),updated_at timestamptz not null default now(),
 unique(connection_id,provider_id),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id),foreign key(workspace_id,user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 check(status not in('suggested','filed') or (message_id is not null and project_id is not null and lead_id is not null and contact_id is not null))
);
do $$ declare relation text;begin foreach relation in array array['crm_mailbox_auto_settings','crm_mailbox_auto_checkpoints','crm_mailbox_id_aliases','crm_mailbox_private_decisions'] loop
 execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
 execute format('create policy mailbox_personal on %I for all to novalure_tenant_app using(crm_mailbox_actor(workspace_id,user_id)) with check(crm_mailbox_actor(workspace_id,user_id))',relation);
 execute format('grant select,insert,update,delete on %I to novalure_tenant_app',relation);
end loop;end $$;
create function crm_mailbox_delegated_identity(w uuid,a uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare result uuid;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then return null;end if;
 select i.id into result from workspace_users u join auth_identities i on i.id=u.auth_identity_id where u.workspace_id=w and u.id=a and u.status='active' and u.product_role<>'external_partner' and i.credential_state='active' and i.disabled_at is null and i.normalized_email=lower(btrim(u.email)) for share of u,i;
 return result;
end $$;
revoke all on function crm_mailbox_delegated_identity(uuid,uuid) from public;grant execute on function crm_mailbox_delegated_identity(uuid,uuid) to novalure_tenant_app;
create function crm_mailbox_auto_settings_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_mailbox_actor(new.workspace_id,new.user_id) or not exists(select 1 from workspace_users u where u.id=new.user_id and u.workspace_id=new.workspace_id and u.status='active' and u.auth_identity_id=new.identity_id) then raise exception using errcode='42501',message='Own current identity delegation required';end if;
 if new.enabled and new.identity_id is distinct from crm_mailbox_delegated_identity(new.workspace_id,new.user_id) then raise exception using errcode='42501',message='Active personally bound identity required';end if;
 if tg_op='UPDATE' and(new.workspace_id<>old.workspace_id or new.user_id<>old.user_id or new.connection_id<>old.connection_id or new.revision<>old.revision+1) then raise exception using errcode='23514',message='Mailbox policy identity immutable; revision must advance';end if;
 return new;
end $$;
create trigger mailbox_auto_settings_guard before insert or update on crm_mailbox_auto_settings for each row execute function crm_mailbox_auto_settings_guard();
revoke all on function crm_mailbox_auto_settings_guard() from public;
create function crm_mailbox_private_decision_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.lead_id is not null and(not crm_project_access(new.workspace_id,new.project_id,false) or not exists(select 1 from leads l where l.workspace_id=new.workspace_id and l.project_id=new.project_id and l.id=new.lead_id and l.contact_id=new.contact_id)) then raise exception using errcode='42501',message='Current personally readable lead/contact required';end if;
 return new;
end $$;
create trigger mailbox_private_decision_guard before insert or update on crm_mailbox_private_decisions for each row execute function crm_mailbox_private_decision_guard();
revoke all on function crm_mailbox_private_decision_guard() from public;
create index mailbox_private_decisions_review on crm_mailbox_private_decisions(workspace_id,user_id,updated_at desc,id) where status in('review','quarantined','suggested');
create index mailbox_private_message_pagination on crm_mailbox_messages(workspace_id,user_id,received_at desc,id desc) where deleted_at is null;
create function crm_mailbox_account_binding_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.provider_account_id is not null and(length(new.provider_account_id) not between 1 and 512) then raise exception using errcode='23514',message='Valid authenticated provider account binding required';end if;
 if tg_op='UPDATE' and((old.provider_account_id is not null and new.provider_account_id is distinct from old.provider_account_id) or(old.provider_id_format='immutable' and new.provider_id_format<>'immutable')) then raise exception using errcode='23514',message='Bound provider account and immutable ID format cannot be reassigned';end if;
 return new;
end $$;
create trigger mailbox_account_binding_guard before insert or update on crm_mailbox_connections for each row execute function crm_mailbox_account_binding_guard();
revoke all on function crm_mailbox_account_binding_guard() from public;
create function crm_mailbox_tombstone_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.deleted_at is not null and(new.deleted_at is null or new.body_text<>'' or new.subject<>'' or new.from_address is not null or new.from_label<>'' or new.to_addresses<>'[]'::jsonb or new.thread_id is not null or new.internet_message_id is not null or new.attachments<>'[]'::jsonb or new.reply_headers<>'{}'::jsonb) then raise exception using errcode='23514',message='Erased private message content cannot be restored';end if;
 return new;
end $$;
create trigger mailbox_tombstone_guard before update on crm_mailbox_messages for each row execute function crm_mailbox_tombstone_guard();
revoke all on function crm_mailbox_tombstone_guard() from public;
