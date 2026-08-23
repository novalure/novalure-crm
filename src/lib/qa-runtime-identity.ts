import { createHash } from "node:crypto";

const projectIdPattern = /^[-A-Za-z0-9]{8,80}$/;
const branchIdPattern = /^br-[-A-Za-z0-9]{8,128}$/;
const databaseIdentifierPattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;

export type QaRuntimeDatabaseIdentityRow = {
  databaseBranchId: string | null;
  databaseName: string | null;
  databaseProjectId: string | null;
  databaseRole: string | null;
  leastPrivilege: boolean;
  rlsActive: boolean;
};

export type QaRuntimeDatabaseIdentity = {
  databaseBranchId: string;
  databaseTargetDigest: string;
  leastPrivilege: boolean;
  rlsActive: boolean;
};

export const qaRuntimeDatabaseIdentitySql = `
  select
    current_setting('neon.project_id', true) as "databaseProjectId",
    current_setting('neon.branch_id', true) as "databaseBranchId",
    current_database() as "databaseName",
    current_user as "databaseRole",
    (
      pg_catalog.row_security_active('public.qa_batches'::regclass)
      and pg_catalog.row_security_active('public.qa_batch_objects'::regclass)
      and pg_catalog.row_security_active('public.qa_reset_audit_events'::regclass)
    ) as "rlsActive",
    (
      current_user = 'novalure_app'
      and exists (
        select 1
        from pg_catalog.pg_roles role_state
        where role_state.rolname = current_user
          and not role_state.rolsuper
          and not role_state.rolbypassrls
      )
      and pg_catalog.pg_has_role(current_user, 'novalure_tenant_app', 'USAGE')
      and not exists (
        select 1
        from unnest(array[
          'public.qa_batches'::regclass,
          'public.qa_batch_objects'::regclass,
          'public.qa_reset_audit_events'::regclass
        ]) as target(relation_oid)
        join pg_catalog.pg_class relation on relation.oid = target.relation_oid
        where pg_catalog.pg_has_role(current_user, relation.relowner, 'MEMBER')
           or pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
      )
      and pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'SELECT')
      and pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'INSERT')
      and pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'SELECT')
      and pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'INSERT')
      and pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'SELECT')
      and pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'INSERT')
      and not exists (
        select 1
        from unnest(array[
          'public.qa_batches'::regclass,
          'public.qa_batch_objects'::regclass,
          'public.qa_reset_audit_events'::regclass
        ]) as target(relation_oid)
        cross join lateral (values
          ('SELECT WITH GRANT OPTION'::text),
          ('INSERT WITH GRANT OPTION'::text)
        ) as forbidden(privilege_name)
        where pg_catalog.has_table_privilege(
          current_user,
          target.relation_oid,
          forbidden.privilege_name
        )
      )
      and not exists (
        select 1
        from unnest(array[
          'public.qa_batches'::regclass,
          'public.qa_batch_objects'::regclass,
          'public.qa_reset_audit_events'::regclass
        ]) as target(relation_oid)
        cross join lateral (values
          ('UPDATE'::text),
          ('REFERENCES'::text),
          ('SELECT WITH GRANT OPTION'::text),
          ('INSERT WITH GRANT OPTION'::text)
        ) as forbidden(privilege_name)
        where pg_catalog.has_any_column_privilege(
          current_user,
          target.relation_oid,
          forbidden.privilege_name
        )
      )
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'UPDATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'DELETE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'TRUNCATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'REFERENCES')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'TRIGGER')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batches', 'MAINTAIN')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'UPDATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'DELETE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'TRUNCATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'REFERENCES')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'TRIGGER')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_batch_objects', 'MAINTAIN')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'UPDATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'DELETE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'TRUNCATE')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'REFERENCES')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'TRIGGER')
      and not pg_catalog.has_table_privilege(current_user, 'public.qa_reset_audit_events', 'MAINTAIN')
    ) as "leastPrivilege"
`;

export function qaRuntimeDatabaseTargetDigest(input: {
  branchId: string;
  databaseName: string;
  projectId: string;
  role: string;
}) {
  return `sha256:${createHash("sha256")
    .update([input.projectId, input.branchId, input.databaseName, input.role].join("\0"))
    .digest("hex")}`;
}

export function evaluateQaRuntimeDatabaseIdentity(
  row: QaRuntimeDatabaseIdentityRow | null | undefined,
): QaRuntimeDatabaseIdentity | null {
  const projectId = row?.databaseProjectId?.trim() ?? "";
  const branchId = row?.databaseBranchId?.trim() ?? "";
  const databaseName = row?.databaseName?.trim() ?? "";
  const role = row?.databaseRole?.trim() ?? "";
  if (
    !projectIdPattern.test(projectId)
    || !branchIdPattern.test(branchId)
    || !databaseIdentifierPattern.test(databaseName)
    || role !== "novalure_app"
  ) return null;

  return Object.freeze({
    databaseBranchId: branchId,
    databaseTargetDigest: qaRuntimeDatabaseTargetDigest({ branchId, databaseName, projectId, role }),
    leastPrivilege: row?.leastPrivilege === true,
    rlsActive: row?.rlsActive === true,
  });
}

export function isQaRuntimeDatabaseIdentityReady(
  identity: QaRuntimeDatabaseIdentity | null | undefined,
): identity is QaRuntimeDatabaseIdentity {
  return Boolean(identity?.leastPrivilege && identity.rlsActive);
}

export function matchesQaRuntimeDatabaseTarget(
  identity: QaRuntimeDatabaseIdentity | null | undefined,
  target: { branchId: string; databaseName: string; projectId: string; role: string },
) {
  return Boolean(
    identity
    && identity.databaseBranchId === target.branchId
    && identity.databaseTargetDigest === qaRuntimeDatabaseTargetDigest(target),
  );
}
