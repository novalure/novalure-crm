alter table deals
  add column if not exists idempotency_key text;

create unique index if not exists deals_workspace_idempotency_key_uidx
  on deals(workspace_id, idempotency_key)
  where idempotency_key is not null;
