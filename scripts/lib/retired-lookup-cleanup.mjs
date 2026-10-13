/** Cleanup may revoke an old password, but only migration 096 retires the login. */
export async function verifyRetiredLookupCleanup(owner) {
  const role = (await owner.query(
    "select rolcanlogin from pg_roles where rolname='novalure_public_form_lookup'",
  )).rows[0];
  if (!role) return "QA_LOOKUP_REVOKE_NOT_REQUIRED";
  const cutover = (await owner.query(`select exists (
    select 1 from novalure_schema_migrations where version='096_public_integration_gateway'
  ) as applied`)).rows[0]?.applied === true;
  if (!cutover) {
    // An interrupted pre-096 rehearsal must preserve the next migration's
    // role-state precondition. Never create or reset a lookup password.
    await owner.query("alter role novalure_public_form_lookup password null");
  }
  const verified = (await owner.query(`select not r.rolcanlogin as nologin,
      a.rolpassword is null as password_revoked,
      not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
        and not r.rolcreaterole and not r.rolreplication as unprivileged
    from pg_roles r join pg_authid a on a.oid=r.oid
    where r.rolname='novalure_public_form_lookup'`)).rows[0];
  if (!verified?.password_revoked || !verified.unprivileged || (cutover && !verified.nologin)) {
    throw new Error("QA_LOOKUP_REVOKE_UNVERIFIED");
  }
  return cutover ? "QA_LOOKUP_REVOKE_PASS lookupRole=NOLOGIN password=NULL"
    : "QA_LOOKUP_PASSWORD_REVOKED cutover096=NOT_APPLIED";
}
