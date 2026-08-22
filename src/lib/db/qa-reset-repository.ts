import { createHash, timingSafeEqual } from "node:crypto";
import {
  isQaResetCascadeOwnedTable,
  isQaResetDatabaseTable,
  isQaResetPlanDigest,
  isQaResetRetainedTable,
  isUuid,
  qaResetCascadeOwnedTables,
  qaResetDatabaseTables,
  qaResetRetainedTables,
  type QaResetDatabaseTable,
  type QaResetMode,
} from "@/lib/qa-reset-contract";
import {
  withTenantTransaction,
  type TenantTransaction,
} from "@/lib/db/tenant-client";
import { hasExecutedQaBatchAudit, lockQaBatchFence } from "@/lib/db/qa-batch-fence";

const maximumBatchObjects = 20_000;
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;
const planDigestDomain = "novalure.qa-reset-plan.v1";
const providerSideEffectTables = new Set<QaResetDatabaseTable>([
  "bot_document_sends",
  "calendar_sync_events",
  "crm_outreach_deliveries",
  "google_notification_jobs",
  "media_assets",
  "meeting_bookings",
  "meeting_notification_jobs",
  "newsletter_sends",
  "property_export_jobs",
  "provider_connections",
  "sequence_step_runs",
  "teams_notification_jobs",
]);
const immutableRetainedTables = new Set([
  "audit_logs",
  "auth_audit_events",
  "qa_batches",
  "qa_batch_objects",
  "qa_reset_audit_events",
]);

type QaWorkspaceRow = {
  id: string;
  isQa: boolean;
};

type QaBatchRow = {
  batchMarker: string;
  id: string;
  workspaceId: string;
};

type QaBatchObjectRow = {
  resourceId: string;
  resourceScope: "blob" | "database" | "provider";
  resourceType: string;
};

type ForeignKeyRow = {
  childColumns: string[];
  childTable: string;
  constraintName: string;
  deleteAction: "a" | "c" | "d" | "n" | "r";
  parentColumns: string[];
  parentTable: string;
};

export type QaResetBlockerCode =
  | "batch_too_large"
  | "external_cleanup_adapter_required"
  | "foreign_batch_or_unregistered_dependency"
  | "immutable_evidence_dependency"
  | "invalid_ledger_resource_id"
  | "provider_side_effect_reconciliation_required"
  | "registered_target_missing_or_foreign"
  | "retained_table_registered_for_deletion"
  | "unsupported_foreign_key_shape"
  | "unknown_dependency_table"
  | "unknown_ledger_resource_type";

export type QaResetBlocker = Readonly<{
  code: QaResetBlockerCode;
  detail: string;
}>;

export type QaResetTarget = Readonly<{
  ids: readonly string[];
  table: QaResetDatabaseTable;
}>;

export type QaResetExternalTarget = Readonly<{
  ids: readonly string[];
  resourceScope: "blob" | "provider";
  resourceType: string;
}>;

export type QaResetPlan = Readonly<{
  batchId: string;
  batchMarker: string;
  blockers: readonly QaResetBlocker[];
  deletionOrder: readonly QaResetDatabaseTable[];
  digest: string;
  externalTargets: readonly QaResetExternalTarget[];
  retainedTables: readonly string[];
  targetCounts: Readonly<Record<string, number>>;
  targets: readonly QaResetTarget[];
  workspaceId: string;
}>;

export type QaResetResult = Readonly<{
  auditEventId: string;
  deletedCounts: Readonly<Record<string, number>>;
  mode: QaResetMode;
  outcome: "blocked" | "dry_run" | "executed";
  plan: QaResetPlan;
}>;

export class QaResetGuardError extends Error {
  readonly code:
    | "batch_already_executed"
    | "batch_not_found"
    | "invalid_actor"
    | "plan_digest_invalid"
    | "plan_digest_mismatch"
    | "plan_digest_required"
    | "workspace_not_allowlisted"
    | "workspace_not_found"
    | "workspace_not_qa";

  constructor(code: QaResetGuardError["code"], message: string) {
    super(message);
    this.name = "QaResetGuardError";
    this.code = code;
  }
}

function quoteIdentifier(value: string) {
  if (!identifierPattern.test(value)) {
    throw new Error("Unsafe database identifier in QA reset contract");
  }
  return `"${value}"`;
}

function addBlocker(blockers: QaResetBlocker[], code: QaResetBlockerCode, detail: string) {
  const boundedDetail = detail.slice(0, 400);
  if (!blockers.some((blocker) => blocker.code === code && blocker.detail === boundedDetail)) {
    blockers.push({ code, detail: boundedDetail });
  }
}

function groupLedgerRows(rows: readonly QaBatchObjectRow[]) {
  const databaseTargets = new Map<QaResetDatabaseTable, Set<string>>();
  const externalTargets = new Map<string, QaResetExternalTarget>();
  const blockers: QaResetBlocker[] = [];

  for (const row of rows) {
    if (row.resourceScope === "database") {
      if (isQaResetRetainedTable(row.resourceType)) {
        addBlocker(
          blockers,
          "retained_table_registered_for_deletion",
          `Immutable/security/telemetry table is not resettable: ${row.resourceType}`,
        );
        continue;
      }
      if (!isQaResetDatabaseTable(row.resourceType)) {
        addBlocker(blockers, "unknown_ledger_resource_type", `Unknown database target: ${row.resourceType}`);
        continue;
      }
      if (!isUuid(row.resourceId)) {
        addBlocker(
          blockers,
          "invalid_ledger_resource_id",
          `Database target id is not a UUID: ${row.resourceType}`,
        );
        continue;
      }
      const ids = databaseTargets.get(row.resourceType) ?? new Set<string>();
      ids.add(row.resourceId.toLowerCase());
      databaseTargets.set(row.resourceType, ids);
      continue;
    }

    if (row.resourceScope !== "blob" && row.resourceScope !== "provider") {
      addBlocker(blockers, "unknown_ledger_resource_type", "Unknown QA ledger resource scope");
      continue;
    }

    const key = `${row.resourceScope}\0${row.resourceType}`;
    const existing = externalTargets.get(key);
    externalTargets.set(key, {
      ids: [...new Set([...(existing?.ids ?? []), row.resourceId])].sort(),
      resourceScope: row.resourceScope,
      resourceType: row.resourceType,
    });
  }

  return { blockers, databaseTargets, externalTargets: [...externalTargets.values()] };
}

function directWorkspaceScopeSql(
  table: QaResetDatabaseTable,
  operation: "delete" | "select",
  options: { lockTarget?: boolean } = {},
) {
  const tableName = quoteIdentifier(table);
  // PostgreSQL FK checks take a KEY SHARE lock on the referenced row. UPDATE is
  // intentionally stronger so a new child reference cannot pass the closure check
  // and commit before this reset transaction deletes its registered parent.
  const targetLock = options.lockTarget ? "for update of target" : "";
  if (table === "knowledge_chunks") {
    if (operation === "select") {
      return `
        select target.id::text as id
        from ${tableName} target
        join knowledge_sources scope on scope.id = target.source_id
        where target.id = any($1::uuid[])
          and scope.workspace_id = $2::uuid
        order by target.id
        ${targetLock}
      `;
    }
    return `
      delete from ${tableName} target
      using knowledge_sources scope
      where target.id = any($1::uuid[])
        and target.source_id = scope.id
        and scope.workspace_id = $2::uuid
      returning target.id::text as id
    `;
  }

  if (operation === "select") {
    return `
      select target.id::text as id
      from ${tableName} target
      where target.id = any($1::uuid[])
        and target.workspace_id::text = $2::text
      order by target.id
      ${targetLock}
    `;
  }
  return `
    delete from ${tableName} target
    where target.id = any($1::uuid[])
      and target.workspace_id::text = $2::text
    returning target.id::text as id
  `;
}

async function verifyRegisteredTargets(
  transaction: TenantTransaction,
  workspaceId: string,
  groupedTargets: ReadonlyMap<QaResetDatabaseTable, Set<string>>,
  blockers: QaResetBlocker[],
  options: { lockTargets: boolean },
) {
  const targets = [...groupedTargets.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [table, idSet] of targets) {
    const ids = [...idSet].sort();
    const rows = await transaction.query<{ id: string }>(
      directWorkspaceScopeSql(table, "select", { lockTarget: options.lockTargets }),
      [ids, workspaceId],
    );
    const found = new Set(rows.map((row) => row.id.toLowerCase()));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      addBlocker(
        blockers,
        "registered_target_missing_or_foreign",
        `${table} contains ${missing.length} missing, deleted, or foreign-tenant ledger target(s)`,
      );
    }
  }
}

async function loadForeignKeys(
  transaction: TenantTransaction,
  parentTables: readonly QaResetDatabaseTable[],
) {
  if (parentTables.length === 0) return [];
  return transaction.query<ForeignKeyRow>(
    `
      select
        child.relname::text as "childTable",
        parent.relname::text as "parentTable",
        constraint_record.conname::text as "constraintName",
        constraint_record.confdeltype::text as "deleteAction",
        array_agg(child_attribute.attname::text order by key_pair.ordinality)::text[] as "childColumns",
        array_agg(parent_attribute.attname::text order by key_pair.ordinality)::text[] as "parentColumns"
      from pg_constraint constraint_record
      join pg_class child on child.oid = constraint_record.conrelid
      join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
      join pg_class parent on parent.oid = constraint_record.confrelid
      join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      join lateral unnest(constraint_record.conkey, constraint_record.confkey)
        with ordinality as key_pair(child_key, parent_key, ordinality) on true
      join pg_attribute child_attribute
        on child_attribute.attrelid = child.oid
       and child_attribute.attnum = key_pair.child_key
      join pg_attribute parent_attribute
        on parent_attribute.attrelid = parent.oid
       and parent_attribute.attnum = key_pair.parent_key
      where constraint_record.contype = 'f'
        and child_namespace.nspname = 'public'
        and parent_namespace.nspname = 'public'
        and parent.relname = any($1::text[])
      group by child.relname, parent.relname, constraint_record.conname, constraint_record.confdeltype
      order by parent.relname, child.relname, constraint_record.conname
    `,
    [parentTables],
  );
}

function foreignReferenceSql(edge: ForeignKeyRow) {
  const parentIdIndex = edge.parentColumns.indexOf("id");
  if (parentIdIndex < 0 || edge.parentColumns.filter((column) => column === "id").length !== 1) {
    return null;
  }
  if (edge.childColumns.length !== edge.parentColumns.length) return null;

  const relationshipPredicates = edge.childColumns.map(
    (childColumn, index) =>
      `child.${quoteIdentifier(childColumn)} = parent_target.${quoteIdentifier(edge.parentColumns[index])}`,
  );
  const parentWorkspaceJoin = edge.parentTable === "knowledge_chunks"
    ? "join knowledge_sources parent_scope on parent_scope.id = parent_target.source_id"
    : "";
  const parentWorkspacePredicate = edge.parentTable === "knowledge_chunks"
    ? "parent_scope.workspace_id::text = $2::text"
    : "parent_target.workspace_id::text = $2::text";

  return `
    select child.id::text as id
    from ${quoteIdentifier(edge.childTable)} child
    join ${quoteIdentifier(edge.parentTable)} parent_target
      on ${relationshipPredicates.join(" and ")}
    ${parentWorkspaceJoin}
    where parent_target.${quoteIdentifier(edge.parentColumns[parentIdIndex])} = any($1::uuid[])
      and ${parentWorkspacePredicate}
    order by child.id
  `;
}

function resolveDeletionOrder(
  targetTables: readonly QaResetDatabaseTable[],
  edges: readonly ForeignKeyRow[],
  blockers: QaResetBlocker[],
) {
  const targetSet = new Set<string>(targetTables);
  const children = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!targetSet.has(edge.parentTable) || !targetSet.has(edge.childTable)) continue;
    if (edge.parentTable === edge.childTable) {
      addBlocker(
        blockers,
        "unsupported_foreign_key_shape",
        `Self-referencing reset graph is not supported: ${edge.constraintName}`,
      );
      continue;
    }
    const set = children.get(edge.parentTable) ?? new Set<string>();
    set.add(edge.childTable);
    children.set(edge.parentTable, set);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: QaResetDatabaseTable[] = [];
  const visit = (table: QaResetDatabaseTable) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      addBlocker(blockers, "unsupported_foreign_key_shape", `Cyclic reset graph contains ${table}`);
      return;
    }
    visiting.add(table);
    for (const child of children.get(table) ?? []) {
      if (isQaResetDatabaseTable(child)) visit(child);
    }
    visiting.delete(table);
    visited.add(table);
    order.push(table);
  };

  for (const table of [...targetTables].sort()) visit(table);
  return order;
}

async function verifyReferentialClosure(
  transaction: TenantTransaction,
  workspaceId: string,
  groupedTargets: ReadonlyMap<QaResetDatabaseTable, Set<string>>,
  edges: readonly ForeignKeyRow[],
  blockers: QaResetBlocker[],
) {
  for (const edge of edges) {
    if (!isQaResetDatabaseTable(edge.parentTable)) continue;
    const parentIds = groupedTargets.get(edge.parentTable);
    if (!parentIds?.size) continue;
    const sql = foreignReferenceSql(edge);
    if (!sql) {
      addBlocker(
        blockers,
        "unsupported_foreign_key_shape",
        `Unsupported FK shape: ${edge.constraintName}`,
      );
      continue;
    }

    const childRows = await transaction.query<{ id: string }>(sql, [[...parentIds], workspaceId]);
    if (childRows.length === 0) continue;

    if (isQaResetCascadeOwnedTable(edge.childTable)) {
      if (edge.deleteAction !== "c") {
        addBlocker(
          blockers,
          "unsupported_foreign_key_shape",
          edge.constraintName + " must cascade-delete derived " + edge.childTable + " rows",
        );
      }
      continue;
    }

    if (isQaResetRetainedTable(edge.childTable)) {
      const immutable = immutableRetainedTables.has(edge.childTable);
      const mutatesOrDeletes = edge.deleteAction !== "n" && edge.deleteAction !== "d";
      if (immutable || mutatesOrDeletes) {
        addBlocker(
          blockers,
          "immutable_evidence_dependency",
          `${edge.constraintName} would mutate/delete retained ${edge.childTable} evidence`,
        );
      }
      continue;
    }
    if (!isQaResetDatabaseTable(edge.childTable)) {
      addBlocker(
        blockers,
        "unknown_dependency_table",
        `${edge.constraintName} reaches non-allowlisted table ${edge.childTable}`,
      );
      continue;
    }

    const registeredChildIds = groupedTargets.get(edge.childTable) ?? new Set<string>();
    const unregistered = childRows
      .map((row) => row.id.toLowerCase())
      .filter((id) => !registeredChildIds.has(id));
    if (unregistered.length > 0) {
      addBlocker(
        blockers,
        "foreign_batch_or_unregistered_dependency",
        `${edge.constraintName} reaches ${unregistered.length} unregistered or foreign-batch row(s)`,
      );
    }
  }
}

function deterministicPlan(input: Omit<QaResetPlan, "digest">): QaResetPlan {
  const serialized = JSON.stringify({
    batchId: input.batchId,
    batchMarker: input.batchMarker,
    blockers: input.blockers,
    deletionOrder: input.deletionOrder,
    externalTargets: input.externalTargets,
    targets: input.targets,
    workspaceId: input.workspaceId,
  });
  return {
    ...input,
    digest: createHash("sha256")
      .update(planDigestDomain)
      .update("\0")
      .update(serialized)
      .digest("hex"),
  };
}

function assertExpectedPlanDigest(expectedPlanDigest: string | null | undefined, actualPlanDigest: string) {
  if (!expectedPlanDigest) {
    throw new QaResetGuardError(
      "plan_digest_required",
      "QA reset execution requires the exact plan digest returned by a preceding dry-run",
    );
  }
  if (!isQaResetPlanDigest(expectedPlanDigest)) {
    throw new QaResetGuardError("plan_digest_invalid", "QA reset expected plan digest is invalid");
  }

  const expected = Buffer.from(expectedPlanDigest, "hex");
  const actual = Buffer.from(actualPlanDigest, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new QaResetGuardError(
      "plan_digest_mismatch",
      "QA reset plan changed after dry-run; repeat the dry-run before execution",
    );
  }
}

async function createPlan(
  transaction: TenantTransaction,
  input: { batch: QaBatchRow; ledgerRows: readonly QaBatchObjectRow[]; workspaceId: string },
  options: { lockTargets: boolean },
) {
  const grouped = groupLedgerRows(input.ledgerRows);
  const blockers = [...grouped.blockers];
  if (input.ledgerRows.length > maximumBatchObjects) {
    addBlocker(blockers, "batch_too_large", `QA batch exceeds ${maximumBatchObjects} ledger objects`);
  }
  if (grouped.externalTargets.length > 0) {
    addBlocker(
      blockers,
      "external_cleanup_adapter_required",
      "Blob/provider targets require a separately verified cleanup adapter before database execution",
    );
  }
  for (const table of grouped.databaseTargets.keys()) {
    if (providerSideEffectTables.has(table)) {
      addBlocker(
        blockers,
        "provider_side_effect_reconciliation_required",
        `${table} may contain external side effects and requires provider reconciliation`,
      );
    }
  }

  await verifyRegisteredTargets(
    transaction,
    input.workspaceId,
    grouped.databaseTargets,
    blockers,
    options,
  );
  const targetTables = [...grouped.databaseTargets.keys()].sort();
  const edges = await loadForeignKeys(transaction, targetTables);
  await verifyReferentialClosure(transaction, input.workspaceId, grouped.databaseTargets, edges, blockers);
  const deletionOrder = resolveDeletionOrder(targetTables, edges, blockers);
  const targets = targetTables.map((table) => ({
    ids: [...(grouped.databaseTargets.get(table) ?? [])].sort(),
    table,
  }));
  const targetCounts = Object.fromEntries([
    ...targets.map((target) => [target.table, target.ids.length] as const),
    ...grouped.externalTargets.map((target) => [
      `${target.resourceScope}:${target.resourceType}`,
      target.ids.length,
    ] as const),
  ]);

  return deterministicPlan({
    batchId: input.batch.id,
    batchMarker: input.batch.batchMarker,
    blockers: blockers.sort((left, right) =>
      `${left.code}:${left.detail}`.localeCompare(`${right.code}:${right.detail}`)),
    deletionOrder,
    externalTargets: grouped.externalTargets.sort((left, right) =>
      `${left.resourceScope}:${left.resourceType}`.localeCompare(`${right.resourceScope}:${right.resourceType}`)),
    retainedTables: [...qaResetRetainedTables],
    targetCounts,
    targets,
    workspaceId: input.workspaceId,
  });
}

async function writeResetAudit(
  transaction: TenantTransaction,
  input: {
    actorId: string;
    mode: QaResetMode;
    outcome: QaResetResult["outcome"];
    plan: QaResetPlan;
    deletedCounts: Readonly<Record<string, number>>;
  },
) {
  const row = await transaction.queryOne<{ id: string }>(
    `
      insert into qa_reset_audit_events (
        workspace_id,
        batch_id,
        actor_user_id,
        mode,
        outcome,
        plan_digest,
        target_counts,
        target_manifest,
        blocker_codes,
        deleted_counts
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::text[], $10::jsonb)
      returning id
    `,
    [
      input.plan.workspaceId,
      input.plan.batchId,
      input.actorId,
      input.mode,
      input.outcome,
      input.plan.digest,
      JSON.stringify(input.plan.targetCounts),
      JSON.stringify({ externalTargets: input.plan.externalTargets, targets: input.plan.targets }),
      input.plan.blockers.map((blocker) => blocker.code),
      JSON.stringify(input.deletedCounts),
    ],
  );
  if (!row) throw new Error("QA reset audit event was not persisted");
  return row.id;
}

async function executePlan(transaction: TenantTransaction, plan: QaResetPlan) {
  const targetByTable = new Map(plan.targets.map((target) => [target.table, target]));
  const deletedCounts: Record<string, number> = {};
  for (const table of plan.deletionOrder) {
    const target = targetByTable.get(table);
    if (!target?.ids.length) continue;
    const rows = await transaction.query<{ id: string }>(
      directWorkspaceScopeSql(table, "delete"),
      [target.ids, plan.workspaceId],
    );
    const deleted = new Set(rows.map((row) => row.id.toLowerCase()));
    if (deleted.size !== target.ids.length || target.ids.some((id) => !deleted.has(id))) {
      throw new Error(`QA reset delete count changed after planning for ${table}`);
    }
    deletedCounts[table] = deleted.size;
  }
  return deletedCounts;
}

export async function runQaBatchResetInTransaction(
  transaction: TenantTransaction,
  input: {
    actorId: string;
    allowlistedWorkspaceIds: ReadonlySet<string>;
    batchId: string;
    expectedPlanDigest?: string | null;
    mode: QaResetMode;
    workspaceId: string;
  },
): Promise<QaResetResult> {
  if (!isUuid(input.actorId)) throw new QaResetGuardError("invalid_actor", "QA reset requires a UUID actor");
  if (!input.allowlistedWorkspaceIds.has(input.workspaceId)) {
    throw new QaResetGuardError("workspace_not_allowlisted", "QA reset workspace is not server-allowlisted");
  }
  if (input.mode === "execute") {
    if (!input.expectedPlanDigest) {
      throw new QaResetGuardError(
        "plan_digest_required",
        "QA reset execution requires the exact plan digest returned by a preceding dry-run",
      );
    }
    if (!isQaResetPlanDigest(input.expectedPlanDigest)) {
      throw new QaResetGuardError("plan_digest_invalid", "QA reset expected plan digest is invalid");
    }
  }

  await lockQaBatchFence(transaction, input.batchId);

  const workspace = await transaction.queryOne<QaWorkspaceRow>(
    `select id, is_qa as "isQa" from workspaces where id = $1::uuid for update`,
    [input.workspaceId],
  );
  if (!workspace) throw new QaResetGuardError("workspace_not_found", "QA reset workspace does not exist");
  if (!workspace.isQa) throw new QaResetGuardError("workspace_not_qa", "QA reset rejected a non-QA workspace");

  const batch = await transaction.queryOne<QaBatchRow>(
    `
      select id, workspace_id as "workspaceId", batch_marker as "batchMarker"
      from qa_batches
      where id = $1::uuid
        and workspace_id = $2::uuid
      for share
    `,
    [input.batchId, input.workspaceId],
  );
  if (!batch) throw new QaResetGuardError("batch_not_found", "QA batch is not registered for this workspace");
  if (await hasExecutedQaBatchAudit(transaction, input)) {
    throw new QaResetGuardError("batch_already_executed", "QA batch was already executed and is permanently sealed");
  }

  const ledgerRows = await transaction.query<QaBatchObjectRow>(
    `
      select
        resource_scope as "resourceScope",
        resource_type as "resourceType",
        resource_id as "resourceId"
      from qa_batch_objects
      where batch_id = $1::uuid
        and workspace_id = $2::uuid
      order by resource_scope, resource_type, resource_id
      limit $3
    `,
    [input.batchId, input.workspaceId, maximumBatchObjects + 1],
  );
  let plan = await createPlan(
    transaction,
    { batch, ledgerRows, workspaceId: input.workspaceId },
    { lockTargets: false },
  );
  if (input.mode === "dry_run") {
    if (plan.blockers.length > 0) {
      const deletedCounts = {};
      const auditEventId = await writeResetAudit(transaction, {
        actorId: input.actorId,
        deletedCounts,
        mode: input.mode,
        outcome: "blocked",
        plan,
      });
      return { auditEventId, deletedCounts, mode: input.mode, outcome: "blocked", plan };
    }
    const deletedCounts = {};
    const auditEventId = await writeResetAudit(transaction, {
      actorId: input.actorId,
      deletedCounts,
      mode: input.mode,
      outcome: "dry_run",
      plan,
    });
    return { auditEventId, deletedCounts, mode: input.mode, outcome: "dry_run", plan };
  }

  // Rebuild the plan after locking every exact target. The locks remain held by
  // this transaction, making this closure result stable through executePlan.
  plan = await createPlan(
    transaction,
    { batch, ledgerRows, workspaceId: input.workspaceId },
    { lockTargets: true },
  );
  assertExpectedPlanDigest(input.expectedPlanDigest, plan.digest);
  if (plan.blockers.length > 0) {
    const deletedCounts = {};
    const auditEventId = await writeResetAudit(transaction, {
      actorId: input.actorId,
      deletedCounts,
      mode: input.mode,
      outcome: "blocked",
      plan,
    });
    return { auditEventId, deletedCounts, mode: input.mode, outcome: "blocked", plan };
  }

  const deletedCounts = await executePlan(transaction, plan);
  const auditEventId = await writeResetAudit(transaction, {
    actorId: input.actorId,
    deletedCounts,
    mode: input.mode,
    outcome: "executed",
    plan,
  });
  return { auditEventId, deletedCounts, mode: input.mode, outcome: "executed", plan };
}

export async function runQaBatchReset(input: {
  actorId: string;
  allowlistedWorkspaceIds: ReadonlySet<string>;
  batchId: string;
  expectedPlanDigest?: string | null;
  mode: QaResetMode;
  workspaceId: string;
}) {
  return withTenantTransaction(
    { actorId: input.actorId, workspaceId: input.workspaceId },
    (transaction) => runQaBatchResetInTransaction(transaction, input),
  );
}

export const qaResetRepositoryContract = Object.freeze({
  cascadeOwnedTables: qaResetCascadeOwnedTables,
  databaseTables: qaResetDatabaseTables,
  maximumBatchObjects,
  providerSideEffectTables: [...providerSideEffectTables],
  retainedTables: qaResetRetainedTables,
});
