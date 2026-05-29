delete from workspaces
where id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and name = 'Novalure Growth';

do $$
begin
  if exists (
    select 1
    from workspace_users
    where product_role in ('novalureGrowth', 'novalureServiceOps', 'novalureAdmin')
  ) then
    raise exception 'Rollback stopped: workspace_users still references one of novalureGrowth, novalureServiceOps or novalureAdmin outside the removed Growth workspace.';
  end if;

  alter table workspace_users drop constraint if exists workspace_users_product_role_check;
  alter table workspace_users
    add constraint workspace_users_product_role_check
    check (
      product_role is null or product_role in (
        'platform_admin',
        'novalure_sales',
        'novalure_onboarding',
        'novalure_customer_success',
        'novalure_operator',
        'customer_owner',
        'workspace_admin',
        'team_member',
        'broker_agent',
        'developer_sales',
        'project_sales_member',
        'assistant_backoffice',
        'external_partner',
        'viewer'
      )
    );
end $$;
