do $$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, update on table media_asset_shares to novalure_app;
    grant select, insert, update, delete on table oauth_authorization_states to novalure_app;
  end if;
end
$$;
