alter table leads
  add column if not exists idempotency_key text;

create unique index if not exists leads_workspace_idempotency_key_uidx
  on leads(workspace_id, idempotency_key)
  where idempotency_key is not null;
