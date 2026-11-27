-- Explicit personal read-only mailbox consent; calendar credentials are separate.
create table crm_mailbox_connections (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),user_id uuid not null,provider text not null check(provider in('google','microsoft')),account_label text not null,
 status text not null check(status in('connected','disconnected','reauthorization_required')),granted_scopes jsonb not null check(jsonb_typeof(granted_scopes)='array'),access_token_encrypted text,refresh_token_encrypted text,expires_at timestamptz,
 revision integer not null default 1,next_cursor text,last_synced_at timestamptz,last_error text,sync_lease_id uuid,sync_lease_until timestamptz,updated_at timestamptz not null default now(),
 unique(workspace_id,user_id,provider,account_label),unique(workspace_id,user_id,id),foreign key(workspace_id,user_id) references workspace_users(workspace_id,id)
);
create table crm_mailbox_oauth_states (
 state_hash text primary key,workspace_id uuid not null references workspaces(id),user_id uuid not null,provider text not null check(provider in('google','microsoft')),nonce_hash text not null,verifier_encrypted text not null,expires_at timestamptz not null,consumed_at timestamptz,
 foreign key(workspace_id,user_id) references workspace_users(workspace_id,id)
);
create table crm_mailbox_messages (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,provider_id text not null,thread_id text,internet_message_id text,subject text not null,from_label text not null,from_address text,to_addresses jsonb not null default '[]',received_at timestamptz not null,body_text text not null check(octet_length(body_text)<=262144),body_truncated boolean not null default false,attachments jsonb not null default '[]' check(jsonb_typeof(attachments)='array'),content_hash text not null,revision integer not null default 1,deleted_at timestamptz,imported_at timestamptz not null default now(),
 unique(connection_id,provider_id),unique(workspace_id,user_id,id),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id)
);
create table crm_mailbox_links (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,message_id uuid not null,project_id uuid not null,lead_id uuid not null,contact_id uuid not null,share_body boolean not null default false,confirmed_reply boolean not null default false,review_reason text not null check(length(trim(review_reason)) between 10 and 1000),created_at timestamptz not null default now(),
 unique(workspace_id,user_id,message_id),foreign key(workspace_id,user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,contact_id) references contacts(workspace_id,id)
);
create table crm_mailbox_sync_runs (
 id uuid primary key,workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,request_id uuid not null,request_hash text not null,status text not null check(status in('running','succeeded','failed','cancelled')),lease_id uuid not null,imported_count integer not null default 0,last_error text,started_at timestamptz not null default now(),finished_at timestamptz,
 unique(workspace_id,user_id,request_id),foreign key(workspace_id,user_id,connection_id) references crm_mailbox_connections(workspace_id,user_id,id)
);
create function crm_mailbox_actor(w uuid,u uuid) returns boolean language sql stable set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and u=nullif(current_setting('app.actor_id',true),'')::uuid and exists(select 1 from workspace_users member where member.workspace_id=w and member.id=u and member.status='active' and member.product_role<>'external_partner')
$$;
do $$ declare relation text; begin foreach relation in array array['crm_mailbox_connections','crm_mailbox_oauth_states','crm_mailbox_messages','crm_mailbox_links','crm_mailbox_sync_runs'] loop
 execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
 execute format('create policy mailbox_personal on %I for all to novalure_tenant_app using(crm_mailbox_actor(workspace_id,user_id)) with check(crm_mailbox_actor(workspace_id,user_id))',relation);
end loop; end $$;
grant select,insert,update,delete on crm_mailbox_connections,crm_mailbox_oauth_states,crm_mailbox_messages,crm_mailbox_links,crm_mailbox_sync_runs to novalure_tenant_app;
revoke all on function crm_mailbox_actor(uuid,uuid) from public;grant execute on function crm_mailbox_actor(uuid,uuid) to novalure_tenant_app;

create function crm_mailbox_link_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not crm_project_access(new.workspace_id,new.project_id,true) or not exists(select 1 from leads l where l.workspace_id=new.workspace_id and l.project_id=new.project_id and l.id=new.lead_id and l.contact_id=new.contact_id)
 or not exists(select 1 from crm_mailbox_messages m where m.id=new.message_id and m.workspace_id=new.workspace_id and m.user_id=new.user_id and m.deleted_at is null)
 then raise exception using errcode='42501',message='Current personal message and lead/contact project permission required'; end if;
 if tg_op='UPDATE' then raise exception using errcode='23514',message='Reviewed message association is immutable; remove it explicitly before a new association'; end if;
 return new;
end $$;
create trigger mailbox_link_guard before insert or update on crm_mailbox_links for each row execute function crm_mailbox_link_guard();
revoke all on function crm_mailbox_link_guard() from public;

create function crm_mailbox_connection_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and(new.id<>old.id or new.workspace_id<>old.workspace_id or new.user_id<>old.user_id or new.provider<>old.provider or new.account_label<>old.account_label or new.revision<>old.revision+1) then raise exception using errcode='23514',message='Mailbox identity is immutable and revision must advance'; end if;
 if new.status='connected' and(new.access_token_encrypted is null or new.expires_at is null or not exists(select 1 from jsonb_array_elements_text(new.granted_scopes) s where(new.provider='google' and s in('https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://mail.google.com/')) or(new.provider='microsoft' and lower(s) in('mail.read','mail.readwrite','https://graph.microsoft.com/mail.read','https://graph.microsoft.com/mail.readwrite')))) then raise exception using errcode='23514',message='Explicit mailbox read permission required; calendar permission is insufficient'; end if;
 if new.status<>'connected' and(new.access_token_encrypted is not null or new.refresh_token_encrypted is not null) then raise exception using errcode='23514',message='Disconnected mailbox cannot retain access credentials'; end if;
 return new;
end $$;
create trigger mailbox_connection_guard before insert or update on crm_mailbox_connections for each row execute function crm_mailbox_connection_guard();
revoke all on function crm_mailbox_connection_guard() from public;
