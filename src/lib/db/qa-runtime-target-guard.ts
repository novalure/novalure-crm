import type { TenantTransaction } from "@/lib/db/tenant-client";
import {
  QaBatchRuntimeError,
  resolveQaRuntimeDatabaseTarget,
} from "@/lib/qa-batch-runtime";

type RuntimeTargetRow = {
  branchId: string | null;
  databaseName: string | null;
  projectId: string | null;
  role: string | null;
};

export const qaRuntimeTargetGuardSql = `
  select
    current_setting('neon.project_id', true) as "projectId",
    current_setting('neon.branch_id', true) as "branchId",
    current_database() as "databaseName",
    current_user as "role"
`;

export async function assertQaRuntimeTargetInTransaction(
  transaction: TenantTransaction,
  env: NodeJS.ProcessEnv = process.env,
) {
  const expected = resolveQaRuntimeDatabaseTarget(env);
  const actual = await transaction.queryOne<RuntimeTargetRow>(qaRuntimeTargetGuardSql);
  if (
    actual?.projectId !== expected.projectId
    || actual.branchId !== expected.branchId
    || actual.databaseName !== expected.databaseName
    || actual.role !== expected.role
  ) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_DATABASE_TARGET_MISMATCH",
      "The active transaction is not bound to the exact isolated Preview database target",
      503,
    );
  }
  return expected;
}
