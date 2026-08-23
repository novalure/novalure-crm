import type { TenantTransaction } from "@/lib/db/tenant-client";
import { hasExecutedQaBatchAudit, lockQaBatchFence } from "@/lib/db/qa-batch-fence";
import {
  isQaResetDatabaseTable,
  type QaResetDatabaseTable,
} from "@/lib/qa-reset-contract";
import {
  QaBatchRuntimeError,
  type QaBatchRegistrationStatus,
} from "@/lib/qa-batch-runtime";

type QaBatchObject = Readonly<{
  id: string;
  type: QaResetDatabaseTable;
}>;

type ExistingRegistrationRow = {
  batchId: string;
  workspaceId: string;
};

export async function assertQaBatchForMutation(
  transaction: TenantTransaction,
  input: { batchId: string; workspaceId: string },
) {
  await lockQaBatchFence(transaction, input.batchId);
  const batch = await transaction.queryOne<{ id: string }>(
    `
      select batch.id
      from qa_batches batch
      inner join workspaces workspace on workspace.id = batch.workspace_id
      where batch.id = $1::uuid
        and batch.workspace_id = $2::uuid
        and workspace.is_qa = true
      -- qa_batches is append-only and the runtime role deliberately has no
      -- UPDATE privilege. Lock the mutable QA boundary, while the advisory batch
      -- fence serializes registration/reset operations for the immutable row.
      for share of workspace
    `,
    [input.batchId, input.workspaceId],
  );
  if (!batch) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_NOT_AVAILABLE",
      "QA batch is not available for this QA workspace",
      409,
    );
  }
  if (await hasExecutedQaBatchAudit(transaction, input)) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_SEALED",
      "QA batch was already reset and is permanently sealed",
      409,
    );
  }
}

export async function assertQaBatchOwnsObject(
  transaction: TenantTransaction,
  input: { batchId: string; object: QaBatchObject; workspaceId: string },
) {
  const registration = await transaction.queryOne<ExistingRegistrationRow>(
    `
      select
        batch_id as "batchId",
        workspace_id as "workspaceId"
      from qa_batch_objects
      where resource_scope = 'database'
        and resource_type = $1
        and resource_id = $2
      limit 1
    `,
    [input.object.type, input.object.id],
  );
  if (
    !registration ||
    registration.batchId !== input.batchId ||
    registration.workspaceId !== input.workspaceId
  ) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_OBJECT_NOT_OWNED",
      "Existing CRM object is not owned by this QA batch",
      409,
    );
  }
}

export async function registerQaBatchObjects(
  transaction: TenantTransaction,
  input: {
    actorId: string;
    batchId: string;
    objects: readonly QaBatchObject[];
    workspaceId: string;
  },
): Promise<QaBatchRegistrationStatus> {
  let inserted = 0;
  const uniqueObjects = new Map<string, QaBatchObject>();
  for (const object of input.objects) {
    if (!isQaResetDatabaseTable(object.type)) {
      throw new QaBatchRuntimeError("QA_BATCH_OBJECT_TYPE_INVALID", "Invalid QA batch object type", 500);
    }
    uniqueObjects.set(`${object.type}:${object.id}`, object);
  }

  for (const object of uniqueObjects.values()) {
    const row = await transaction.queryOne<{ id: string }>(
      `
        insert into qa_batch_objects (
          workspace_id,
          batch_id,
          resource_scope,
          resource_type,
          resource_id,
          created_by_user_id,
          metadata
        )
        values ($1::uuid, $2::uuid, 'database', $3, $4, $5::uuid, $6::jsonb)
        on conflict (resource_scope, resource_type, resource_id) do nothing
        returning id
      `,
      [
        input.workspaceId,
        input.batchId,
        object.type,
        object.id,
        input.actorId,
        JSON.stringify({ source: "qa_batch_runtime", version: 1 }),
      ],
    );
    if (row) {
      inserted += 1;
      continue;
    }
    await assertQaBatchOwnsObject(transaction, {
      batchId: input.batchId,
      object,
      workspaceId: input.workspaceId,
    });
  }

  return inserted > 0 ? "committed" : "already-registered";
}

/**
 * A row returned by an idempotency conflict is pre-existing, not created by the
 * current transaction. Its ownership must therefore be proven before this
 * transaction is allowed to append any QA ledger row.
 */
export async function registerQaBatchObjectsWithOwnershipGuard(
  transaction: TenantTransaction,
  input: {
    actorId: string;
    batchId: string;
    objects: readonly QaBatchObject[];
    preExistingObjects: readonly QaBatchObject[];
    workspaceId: string;
  },
) {
  const checked = new Set<string>();
  for (const object of input.preExistingObjects) {
    const key = `${object.type}:${object.id}`;
    if (checked.has(key)) continue;
    checked.add(key);
    await assertQaBatchOwnsObject(transaction, {
      batchId: input.batchId,
      object,
      workspaceId: input.workspaceId,
    });
  }

  return registerQaBatchObjects(transaction, input);
}
