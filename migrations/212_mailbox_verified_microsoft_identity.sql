-- Additive Microsoft identity binding; existing connections are not reclassified.
alter table crm_mailbox_connections add column provider_tenant_id uuid;
alter table crm_mailbox_connections add column provider_subject text;
alter table crm_mailbox_connections add constraint mailbox_verified_identity_complete check (
  (provider_tenant_id is null and provider_subject is null) or
  (provider = 'microsoft' and provider_tenant_id is not null and provider_subject is not null and length(provider_subject) between 1 and 255 and provider_account_id is not null)
);

create function crm_mailbox_verified_identity_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.provider_tenant_id is not null and
    (new.provider_tenant_id is distinct from old.provider_tenant_id or new.provider_subject is distinct from old.provider_subject or new.provider_account_id is distinct from old.provider_account_id or new.provider is distinct from old.provider) then
   raise exception using errcode='23514',message='Verified provider identity cannot be reassigned';
 end if;
 if tg_op='UPDATE' and old.provider_tenant_id is null and new.provider_tenant_id is not null then
   raise exception using errcode='23514',message='Legacy mailbox copies cannot be reclassified';
 end if;
 return new;
end $$;
create trigger mailbox_verified_identity_guard before update on crm_mailbox_connections for each row execute function crm_mailbox_verified_identity_guard();
revoke all on function crm_mailbox_verified_identity_guard() from public;
