import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "./auth/session";
import { assertCrmFields, assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "./crm-command";
import { hasProductCapability } from "./product-model";
import { archiveKnowledgeArea } from "./knowledge-center/repository";
import { savePropertyCreationDraft } from "./db/property-create-draft-repository";

const VERSION = "qa-registered-retirement-v1";
const LIMIT = 100;
const digestPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-z_][a-z0-9_]*$/;
const supported = {
  projects: { action: "archive", project: "id" },
  bots: { action: "deactivate", project: "project_id" },
  crm_property_creation_drafts: { action: "discard", project: "project_id" },
  knowledge_areas: { action: "archive", project: "project_id" },
} as const;
type Kind = keyof typeof supported;
type TargetId = { type: string; id: string };
type Target = TargetId & { projectId: string | null; action: string; stateDigest: string };
type Blocker = { code: string; type?: string; id?: string };
export type QaCleanupPlan = {
  version: typeof VERSION; workspaceId: string; batchId: string; actorId: string;
  batchDigest: string; ledgerDigest: string; dependencyDigest: string;
  targets: Target[]; counts: Record<string, number>; blockers: Blocker[]; digest: string;
};
type Metadata = { idempotencyKey: string; correlationId: string };
type Result = Record<string, unknown> & { persisted: true; outcome: "blocked" | "dry_run" | "executed" };
export type QaCleanupInput = { mode: "dry_run"; batchId: string } | {
  mode: "execute"; batchId: string; planId: string; expectedPlanDigest: string;
  expectedCounts: Record<string, number>; expectedTargets: TargetId[]; confirmation: string;
};
type ForeignKey = {
  schema: string; table: string; columns: string[]; parentColumns: string[];
  validated: boolean; rls: boolean; forced: boolean; selectable: boolean;
};
const fail = (code: string, message: string, status = 409): never => { throw new CrmCommandError(code, message, status); };
const quote = (value: string) => { if (!identifier.test(value)) return fail("QA_SCHEMA_UNSUPPORTED", "Unsupported database identifier"); return `"${value}"`; };
const optionsWithBudget = (options: TenantTransactionOptions) => ({ ...options, statementTimeoutMs: 15_000, poolAcquireTimeoutMs: 5_000 });

export function parseQaCleanupInput(value: unknown): QaCleanupInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_INPUT", "JSON object required", 400);
  const input = value as Record<string, unknown>;
  const common = ["mode", "batchId", "idempotencyKey", "correlationId"];
  assertCrmFields(input, input.mode === "dry_run" ? common : [...common, "planId", "expectedPlanDigest", "expectedCounts", "expectedTargets", "confirmation"]);
  const batchId = assertCrmUuid(input.batchId, "batchId");
  if (input.mode === "dry_run") return { mode: "dry_run", batchId };
  if (input.mode !== "execute" || typeof input.expectedPlanDigest !== "string" || !digestPattern.test(input.expectedPlanDigest) || typeof input.confirmation !== "string") return fail("INVALID_INPUT", "Choose a supported cleanup mode and exact plan", 400);
  const counts = input.expectedCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.entries(counts).some(([key, count]) => !identifier.test(key) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > LIMIT)) return fail("INVALID_COUNTS", "Exact positive target counts required", 400);
  if (!Array.isArray(input.expectedTargets) || !input.expectedTargets.length || input.expectedTargets.length > LIMIT) return fail("INVALID_TARGETS", "Exact bounded target IDs required", 400);
  const targets = input.expectedTargets.map((item): TargetId => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("INVALID_TARGETS", "Invalid target", 400);
    assertCrmFields(item, ["type", "id"]);
    const target = item as Record<string, unknown>;
    if (typeof target.type !== "string" || !identifier.test(target.type)) return fail("INVALID_TARGETS", "Invalid target type", 400);
    return { type: target.type, id: assertCrmUuid(target.id, "targetId") };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  if (new Set(targets.map(target => `${target.type}:${target.id}`)).size !== targets.length) return fail("INVALID_TARGETS", "Duplicate target ID", 400);
  return { mode: "execute", batchId, planId: assertCrmUuid(input.planId, "planId"), expectedPlanDigest: input.expectedPlanDigest, expectedCounts: counts as Record<string, number>, expectedTargets: targets, confirmation: input.confirmation };
}

function sessionAuthority(session: AppSession) {
  if (!session.authenticated || !["cookie", "database"].includes(session.source) || session.serviceIdentity || !session.authSessionId || !session.authIdentityId || !["owner", "admin"].includes(session.role) || !session.permissions.includes("crm:write") || !hasProductCapability(session.productRole, "settings:manage")) return fail("QA_CLEANUP_FORBIDDEN", "An active persisted workspace administration session is required", 403);
}

async function lockBatch(tx: TenantTransaction, session: AppSession, batchId: string) {
  sessionAuthority(session);
  const manager = await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [session.workspaceId]);
  if (!manager?.allowed) return fail("QA_CLEANUP_FORBIDDEN", "Current workspace administration authority is required", 403);
  // currentMember's 080 helper already holds the workspace/member SHARE locks.
  const workspace = await tx.queryOne<{ isQa: boolean }>("select is_qa as \"isQa\" from workspaces where id=$1::uuid", [session.workspaceId]);
  if (workspace?.isQa !== true) return fail("QA_WORKSPACE_REQUIRED", "Workspace is not explicitly registered for QA", 403);
  // FOR UPDATE also conflicts with the ledger FK's KEY SHARE, so registration
  // cannot append new batch objects while a plan or execution is being built.
  const batch = await tx.queryOne<{ id: string; marker: string; digest: string }>("select id::text,marker,digest from crm_qa_lock_registered_batch($1::uuid,$2::uuid)", [session.workspaceId, batchId]);
  if (!batch || !/^QA-TEST-[0-9]{8}-[0-9]{4}-[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(batch.marker)) return fail("QA_BATCH_NOT_FOUND", "Registered QA batch is unavailable", 404);
  return batch;
}

async function foreignKeys(tx: TenantTransaction, table: Kind): Promise<ForeignKey[]> {
  return tx.query<ForeignKey>(`select ns.nspname as "schema",child.relname as "table",
    array(select a.attname::text from unnest(fk.conkey) with ordinality key(attnum,n) join pg_attribute a on a.attrelid=fk.conrelid and a.attnum=key.attnum order by key.n) as "columns",
    array(select a.attname::text from unnest(fk.confkey) with ordinality key(attnum,n) join pg_attribute a on a.attrelid=fk.confrelid and a.attnum=key.attnum order by key.n) as "parentColumns",
    fk.convalidated as validated,child.relrowsecurity as rls,child.relforcerowsecurity as forced,has_table_privilege(current_user,child.oid,'SELECT') as selectable
    from pg_constraint fk join pg_class child on child.oid=fk.conrelid join pg_namespace ns on ns.oid=child.relnamespace
    where fk.contype='f' and fk.confrelid=to_regclass($1) order by ns.nspname,child.relname,fk.conname`, [`public.${table}`]);
}

async function buildPlan(tx: TenantTransaction, session: AppSession, batchId: string, batchDigest: string): Promise<QaCleanupPlan> {
  const ledger = await tx.query<{ type: string; id: string; scope: string; digest: string }>(`select resource_type as type,resource_id as id,resource_scope as scope,encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') as digest from qa_batch_objects o where workspace_id=$1::uuid and batch_id=$2::uuid order by resource_type,resource_id limit 101`, [session.workspaceId, batchId]);
  const blockers: Blocker[] = [];
  const targets: Target[] = [];
  const dependencies: unknown[] = [];
  if (!ledger.length || ledger.length > LIMIT) blockers.push({ code: ledger.length ? "QA_BATCH_TOO_LARGE" : "QA_BATCH_EMPTY" });
  const registered = new Set(ledger.map(row => `${row.type}:${row.id}`));
  for (const record of ledger.slice(0, LIMIT)) {
    if (record.scope !== "database" || !Object.hasOwn(supported, record.type)) { blockers.push({ code: "QA_RESOURCE_UNSUPPORTED", type: record.type }); continue; }
    const type = record.type as Kind;
    const rule = supported[type];
    const table = quote(type);
    const row = await tx.queryOne<{ projectId: string | null; stateDigest: string; status?: string; userId?: string; archived?: boolean }>(`select ${quote(rule.project)}::text as "projectId",encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') as "stateDigest",${type === "knowledge_areas" ? "(archived_at is not null) as archived" : "status"}${type === "crm_property_creation_drafts" ? ',user_id::text as "userId"' : ''} from ${table} t where workspace_id=$1::uuid and id=$2::uuid for update`, [session.workspaceId, record.id]);
    if (!row) { blockers.push({ code: "QA_REGISTERED_OBJECT_UNAVAILABLE", type, id: record.id }); continue; }
    if (row.projectId) await assertProjectGrant(tx, session, row.projectId, true);
    if (type === "crm_property_creation_drafts" && (row.userId !== session.userId || row.status !== "active")) blockers.push({ code: "QA_DRAFT_NOT_OWN_ACTIVE", type, id: record.id });
    if (type === "knowledge_areas" && row.archived) blockers.push({ code: "QA_ALREADY_RETIRED", type, id: record.id });
    if (type === "projects" && row.status === "Archiviert") blockers.push({ code: "QA_ALREADY_RETIRED", type, id: record.id });
    if (type === "bots" && ["inactive", "paused"].includes(row.status ?? "")) blockers.push({ code: "QA_ALREADY_RETIRED", type, id: record.id });
    targets.push({ type, id: record.id, projectId: row.projectId, action: rule.action, stateDigest: row.stateDigest });
    const fks = await foreignKeys(tx, type);
    if (fks.length > LIMIT) { blockers.push({ code: "QA_DEPENDENCY_LIMIT", type, id: record.id }); continue; }
    dependencies.push({ type, fks });
    const scanned = new Set<string>();
    for (const fk of fks) {
      const idIndex = fk.parentColumns.indexOf("id");
      if (idIndex < 0) { blockers.push({ code: "QA_DEPENDENCY_SCHEMA_UNPROVEN", type, id: record.id }); continue; }
      const column = fk.columns[idIndex];
      const key = `${fk.schema}.${fk.table}.${column}`;
      if (scanned.has(key)) continue;
      scanned.add(key);
      // RLS must not hide a foreign-tenant successor. A validated composite
      // FK proves every row referencing this ID shares its workspace, even if
      // the historical single-column FK is also retained on the same table.
      const tenantBound = fks.some(candidate => candidate.schema === fk.schema && candidate.table === fk.table && candidate.validated && candidate.parentColumns.some((name, index) => name === "id" && candidate.columns[index] === column) && candidate.parentColumns.some((name, index) => name === "workspace_id" && candidate.columns[index] === "workspace_id"));
      if (fk.schema !== "public" || !fk.rls || !fk.forced || !fk.selectable || !tenantBound) { blockers.push({ code: "QA_DEPENDENCY_SCHEMA_UNPROVEN", type, id: record.id }); continue; }
      if (!Object.hasOwn(supported, fk.table)) {
        // Only a tenant-proven, RLS-enforced empty relation is safe to omit.
        // Do not return unknown row contents or adopt unsupported successors.
        const child = await tx.queryOne(`select 1 as present from ${quote(fk.table)} where workspace_id=$1::uuid and ${quote(column)}=$2::uuid limit 1`, [session.workspaceId, record.id]);
        dependencies.push({ type, id: record.id, unsupportedChildType: fk.table, present: Boolean(child) });
        if (child) blockers.push({ code: "QA_DEPENDENCY_TYPE_UNSUPPORTED", type, id: record.id });
        continue;
      }
      const children = await tx.query<{ id: string }>(`select id::text from ${quote(fk.table)} where workspace_id=$1::uuid and ${quote(column)}=$2::uuid order by id limit 101 for update`, [session.workspaceId, record.id]);
      if (children.length > LIMIT) blockers.push({ code: "QA_DEPENDENCY_LIMIT", type, id: record.id });
      for (const child of children) if (!registered.has(`${fk.table}:${child.id}`)) blockers.push({ code: "QA_UNREGISTERED_SUCCESSOR", type, id: record.id });
      dependencies.push({ type, id: record.id, childType: fk.table, childIds: children.map(child => child.id) });
    }
    if (type === "knowledge_areas") {
      // The normal archive helper also archives its sources. Until a source
      // adapter exists, require a proven empty source set rather than adopting it.
      const source = await tx.queryOne("select id from knowledge_sources where workspace_id=$1::uuid and knowledge_area_id=$2::uuid limit 1", [session.workspaceId, record.id]);
      if (source) blockers.push({ code: "QA_KNOWLEDGE_SOURCES_UNSUPPORTED", type, id: record.id });
    }
  }
  const counts: Record<string, number> = {};
  for (const target of targets) counts[target.type] = (counts[target.type] ?? 0) + 1;
  const content: Omit<QaCleanupPlan, "digest"> = { version: VERSION, workspaceId: session.workspaceId, batchId, actorId: session.userId, batchDigest, ledgerDigest: crmPayloadDigest(ledger), dependencyDigest: crmPayloadDigest(dependencies), targets, counts, blockers };
  return { ...content, digest: crmPayloadDigest(content) };
}

async function recordAudit(tx: TenantTransaction, session: AppSession, batchId: string, mode: "dry_run" | "execute", outcome: "blocked" | "dry_run" | "executed", plan: QaCleanupPlan, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await tx.execute(`insert into qa_reset_audit_events(id,workspace_id,batch_id,actor_user_id,mode,outcome,plan_digest,target_counts,target_manifest,blocker_codes,deleted_counts) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8::jsonb,$9::jsonb,$10::text[],'{}'::jsonb)`, [id, session.workspaceId, batchId, session.userId, mode, outcome, plan.digest, JSON.stringify(plan.counts), JSON.stringify({ ...plan, ...extra }), [...new Set(plan.blockers.map(blocker => blocker.code))]]);
  return id;
}

async function retire(tx: TenantTransaction, session: AppSession, target: Target, commandId: string) {
  if (target.type === "knowledge_areas") return archiveKnowledgeArea(session, { areaId: target.id });
  if (target.type === "crm_property_creation_drafts") {
    const row = await tx.queryOne<{ draft: unknown; step: number; revision: number }>("select draft,step,revision from crm_property_creation_drafts where workspace_id=$1::uuid and id=$2::uuid and user_id=$3::uuid for update", [session.workspaceId, target.id, session.userId]);
    if (!row) return fail("QA_OBJECT_CHANGED", "Own registered draft is unavailable");
    return savePropertyCreationDraft(tx, session, { id: target.id, draft: row.draft, step: row.step, expectedRevision: row.revision, requestId: commandId, discard: true });
  }
  // The generic bot editor resets omitted configuration fields. These narrow
  // lifecycle updates preserve all config/identity fields and the normal RLS.
  const changed = target.type === "projects"
    ? await tx.queryOne("update projects set status='Archiviert',version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status<>'Archiviert' returning id", [session.workspaceId, target.id])
    : await tx.queryOne("update bots set status='inactive',updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status not in ('inactive','paused') returning id", [session.workspaceId, target.id]);
  if (!changed) return fail("QA_OBJECT_CHANGED", "Registered object retirement was not confirmed");
  return { id: target.id };
}

export async function runQaCleanup(session: AppSession, raw: unknown, metadata: Metadata, options: TenantTransactionOptions = {}) {
  const input = parseQaCleanupInput(raw);
  sessionAuthority(session);
  return withCrmRead(session, async (tx, fresh) => {
    const batch = await lockBatch(tx, fresh, input.batchId);
    if (input.mode === "dry_run") return executeCrmCommand<Result>(fresh, { ...metadata, operation: "qa.cleanup.plan", resourceId: input.batchId, capability: "settings:manage", payload: input }, async () => {
      const plan = await buildPlan(tx, fresh, input.batchId, batch.digest);
      const outcome = plan.blockers.length ? "blocked" as const : "dry_run" as const;
      const planId = await recordAudit(tx, fresh, input.batchId, "dry_run", outcome, plan);
      return { version: VERSION, persisted: true, outcome, planId, plan, businessMutations: false };
    }, optionsWithBudget(options));
    const stored = await tx.queryOne<{ plan: QaCleanupPlan; digest: string; counts: Record<string, number>; expired: boolean }>(`select target_manifest as plan,plan_digest as digest,target_counts as counts,occurred_at < now()-interval '15 minutes' as expired from qa_reset_audit_events where id=$1::uuid and workspace_id=$2::uuid and batch_id=$3::uuid and actor_user_id=$4::uuid and mode='dry_run' and outcome='dry_run'`, [input.planId, fresh.workspaceId, input.batchId, fresh.userId]);
    if (!stored || stored.plan.version !== VERSION || stored.plan.actorId !== fresh.userId || stored.plan.workspaceId !== fresh.workspaceId || stored.plan.batchId !== input.batchId || stored.plan.blockers.length || input.confirmation !== `RETIRE QA BATCH ${fresh.workspaceId} ${input.batchId}` || stored.digest !== input.expectedPlanDigest || stored.plan.digest !== stored.digest || crmPayloadDigest(stored.counts) !== crmPayloadDigest(input.expectedCounts) || crmPayloadDigest(stored.plan.targets.map(({ type, id }) => ({ type, id }))) !== crmPayloadDigest(input.expectedTargets)) return fail("QA_PLAN_MISMATCH", "Exact own plan, target IDs, counts, digest and confirmation required");
    for (const target of stored.plan.targets) if (target.projectId) await assertProjectGrant(tx, fresh, target.projectId, true);
    return executeCrmCommand<Result>(fresh, { ...metadata, operation: "qa.cleanup.execute", resourceId: input.batchId, capability: "settings:manage", payload: input }, async (_tx, context) => {
      const previous = await tx.queryOne<{ auditId: string; result: Record<string, unknown> }>(`select id::text as "auditId",target_manifest->'executionResult' as result from qa_reset_audit_events where workspace_id=$1::uuid and batch_id=$2::uuid and mode='execute' and outcome='executed' and target_manifest->>'sourcePlanId'=$3 order by occurred_at limit 1`, [fresh.workspaceId, input.batchId, input.planId]);
      if (previous) {
        if (!previous.result || previous.result.outcome !== "executed") return fail("QA_RECEIPT_INVALID", "Stored execution receipt is invalid");
        return { ...previous.result, auditId: previous.auditId, outcome: "executed", persisted: true, historicalExecutionReceiptOnly: true };
      }
      if (stored.expired) return fail("QA_PLAN_EXPIRED", "Create a fresh cleanup plan");
      const current = await buildPlan(tx, fresh, input.batchId, batch.digest);
      if (current.blockers.length || current.digest !== stored.digest || crmPayloadDigest(current) !== crmPayloadDigest(stored.plan)) {
        const blocked = { ...current, blockers: [...current.blockers, { code: "QA_PLAN_STALE" }] };
        const { digest: oldDigest, ...blockedContent } = blocked;
        void oldDigest;
        blocked.digest = crmPayloadDigest(blockedContent);
        const auditId = await recordAudit(tx, fresh, input.batchId, "execute", "blocked", blocked, { sourcePlanId: input.planId });
        return { version: VERSION, persisted: true, outcome: "blocked" as const, auditId, blockers: blocked.blockers, businessMutations: false };
      }
      const retiredCounts: Record<string, number> = {};
      for (const target of current.targets) {
        await retire(tx, context.session, target, context.commandId);
        retiredCounts[target.type] = (retiredCounts[target.type] ?? 0) + 1;
      }
      const result: Result = { version: VERSION, persisted: true, outcome: "executed", sourcePlanId: input.planId, planDigest: current.digest, retiredCounts, deletedCounts: {}, historicalExecutionReceiptOnly: true };
      const auditId = await recordAudit(tx, fresh, input.batchId, "execute", "executed", current, { sourcePlanId: input.planId, executionResult: result });
      return { ...result, auditId };
    }, optionsWithBudget(options));
  }, optionsWithBudget(options));
}
