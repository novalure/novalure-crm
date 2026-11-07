-- Personal mail only. Existing read-only grants never imply send consent.
alter table crm_mailbox_connections add column send_consent_id uuid,
 add column send_consent_identity_id uuid,add column send_consented_at timestamptz;
alter table crm_mailbox_connections add constraint mailbox_send_consent_complete check (
 (send_consent_id is null and send_consent_identity_id is null and send_consented_at is null)
 or (send_consent_id is not null and send_consent_identity_id is not null and send_consented_at is not null));
alter table crm_mailbox_messages add constraint mailbox_message_connection_scope unique(workspace_id,user_id,connection_id,id);

create table crm_mailbox_attachment_files (
 id uuid primary key,workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,message_id uuid not null,
 provider_attachment_id text,source_kind text not null check(source_kind in('received','upload')),
 file_name text not null check(length(file_name) between 1 and 180),mime_type text not null,
 content_sha256 text not null check(content_sha256~'^[a-f0-9]{64}$'),size_bytes integer not null check(size_bytes between 1 and 2097152),
 content_encrypted text,status text not null check(status in('ready','rejected','erased')),check_code text not null,
 created_at timestamptz not null default now(),unique(workspace_id,user_id,id),
 foreign key(workspace_id,user_id,connection_id,message_id) references crm_mailbox_messages(workspace_id,user_id,connection_id,id),
 check((status='ready' and content_encrypted is not null and octet_length(content_encrypted)<=4000000) or (status<>'ready' and content_encrypted is null)),
 check((source_kind='received' and provider_attachment_id is not null) or (source_kind='upload' and provider_attachment_id is null))
);
create unique index mailbox_received_attachment_once on crm_mailbox_attachment_files(connection_id,message_id,provider_attachment_id) where provider_attachment_id is not null;
create function crm_mailbox_attachment_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op<>'UPDATE' or old.status<>'ready' or new.status<>'erased' or new.content_encrypted is not null or
   (to_jsonb(new)-array['status','content_encrypted']) is distinct from (to_jsonb(old)-array['status','content_encrypted']) then
  raise exception using errcode='23514',message='Private attachment evidence is immutable; only ready bytes may be erased';
 end if;
 return new;
end $$;
create trigger mailbox_attachment_immutable before update or delete on crm_mailbox_attachment_files for each row execute function crm_mailbox_attachment_guard();
create trigger mailbox_attachment_no_truncate before truncate on crm_mailbox_attachment_files for each statement execute function crm_reject_immutable_mutation();
revoke all on function crm_mailbox_attachment_guard() from public;

create table crm_mailbox_send_jobs (
 id uuid primary key,workspace_id uuid not null,user_id uuid not null,connection_id uuid not null,message_id uuid not null,
 project_id uuid not null,contact_id uuid not null,lead_id uuid not null,identity_id uuid not null,send_consent_id uuid not null,
 approval_digest text not null check(approval_digest~'^[a-f0-9]{64}$'),source_revision integer not null,
 provider text not null check(provider in('microsoft','google')),account_label text not null,provider_account_id text not null,
 recipient_email text not null,subject text not null,body_text text not null check(octet_length(body_text) between 1 and 65536),
 thread_id text not null,source_provider_id text not null,source_internet_id text not null,internet_message_id text not null,
 attachment_manifest jsonb not null check(jsonb_typeof(attachment_manifest)='array' and jsonb_array_length(attachment_manifest)<=5),
 status text not null default 'prepared' check(status in('prepared','dispatching','accepted','uncertain','suppressed','rejected')),
 provider_message_id text,provider_receipt jsonb,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 accepted_at timestamptz,unique(workspace_id,user_id,id),
 foreign key(workspace_id,user_id,connection_id,message_id) references crm_mailbox_messages(workspace_id,user_id,connection_id,id),
 foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 check((status='accepted' and provider_receipt is not null and accepted_at is not null) or status<>'accepted')
);
create index mailbox_send_personal_history on crm_mailbox_send_jobs(workspace_id,user_id,message_id,created_at);
create unique index mailbox_approved_reply_once on crm_mailbox_send_jobs(connection_id,message_id,approval_digest) where status in('prepared','dispatching','accepted','uncertain');
do $$ declare relation text;begin foreach relation in array array['crm_mailbox_attachment_files','crm_mailbox_send_jobs'] loop
 execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
 execute format('create policy mailbox_personal on %I for all to novalure_tenant_app using(crm_mailbox_actor(workspace_id,user_id)) with check(crm_mailbox_actor(workspace_id,user_id))',relation);
 execute format('revoke all on %I from public,novalure_app',relation);
 execute format('grant select,insert,update on %I to novalure_tenant_app',relation);
end loop;end $$;
create function crm_mailbox_send_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op<>'UPDATE' then raise exception using errcode='23514',message='Personal send evidence cannot be deleted';end if;
 if (to_jsonb(new)-array['status','provider_message_id','provider_receipt','error_code','updated_at','accepted_at']) is distinct from
    (to_jsonb(old)-array['status','provider_message_id','provider_receipt','error_code','updated_at','accepted_at']) then
  raise exception using errcode='23514',message='Approved personal reply is immutable';end if;
 if old.status in('accepted','uncertain','suppressed','rejected') then raise exception using errcode='23514',message='Personal send outcome is terminal; never retry an uncertain send';end if;
 if not ((old.status='prepared' and new.status in('dispatching','suppressed')) or
         (old.status='dispatching' and new.status in('accepted','uncertain','suppressed','rejected'))) then
  raise exception using errcode='23514',message='Invalid personal send transition';end if;
 return new;
end $$;
create trigger mailbox_send_immutable before update or delete on crm_mailbox_send_jobs for each row execute function crm_mailbox_send_guard();
create trigger mailbox_send_no_truncate before truncate on crm_mailbox_send_jobs for each statement execute function crm_reject_immutable_mutation();
revoke all on function crm_mailbox_send_guard() from public;
comment on table crm_mailbox_send_jobs is 'Approved personal replies: durable prepared claim then dispatching before provider I/O. Unknown outcomes are terminal and never automatically retried. Provider acceptance is not delivery.';
comment on table crm_mailbox_attachment_files is 'Encrypted private bounded content, context-bound to the personal message. No public object/link and no implicit knowledge publication.';
