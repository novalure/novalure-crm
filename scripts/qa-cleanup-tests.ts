import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { CrmCommandError, withCrmRead } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { emptyPropertyCreationDraft } from "../src/lib/property-create-draft";
import { savePropertyCreationDraft } from "../src/lib/db/property-create-draft-repository";
import { parseQaCleanupInput, runQaCleanup, type QaCleanupPlan } from "../src/lib/qa-cleanup";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("cleanup protocol requires exact IDs/counts/digest and rejects actor or workspace payload claims", () => {
  const batchId = randomUUID();
  assert.deepEqual(parseQaCleanupInput({ mode: "dry_run", batchId }), { mode: "dry_run", batchId });
  for (const extra of [{ actorId: randomUUID() }, { workspaceId: randomUUID() }, { adopt: true }, { deleteAudit: true }]) assert.throws(() => parseQaCleanupInput({ mode: "dry_run", batchId, ...extra }));
  const input = { mode: "execute", batchId, planId: randomUUID(), expectedPlanDigest: "a".repeat(64), expectedCounts: { bots: 1 }, expectedTargets: [{ type: "bots", id: randomUUID() }], confirmation: "not an authority" };
  assert.equal(parseQaCleanupInput(input).mode, "execute");
  for (const change of [{ expectedPlanDigest: "bad" }, { expectedCounts: { bots: -1 } }, { expectedTargets: [] }, { expectedTargets: [input.expectedTargets[0], input.expectedTargets[0]] }]) assert.throws(() => parseQaCleanupInput({ ...input, ...change }));
});

test("registered cleanup keeps real tenant/session/ledger/immutable evidence boundaries", { timeout: 240_000 }, async t => {
  const db = await startLocalSalesDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Provider egress is forbidden in this fixture"); };
  const options = { pool: db.pool as unknown as TenantPool };
  const metadata = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
  type PlanResponse = { outcome: string; planId: string; plan: QaCleanupPlan };
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    await db.admin.query(await readFile("migrations/173_property_creation_drafts.sql", "utf8"));
    await db.admin.query(await readFile("migrations/194_qa_registered_batch_lock.sql", "utf8"));
    async function tenant() {
      const workspaceId = randomUUID(), userId = randomUUID(), sessionId = randomUUID();
      await db.admin.query("insert into workspaces(id,name,is_qa,operating_model) values($1,'SYNTHETIC QA CLEANUP',true,'self_service_customer')", [workspaceId]);
      const member = await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC QA owner',$3,'owner','customer_owner','active') returning auth_identity_id", [userId, workspaceId, `qa-cleanup-${userId}@example.invalid`]);
      const authIdentityId = member.rows[0].auth_identity_id as string;
      await db.admin.query("update auth_identities set credential_state='active' where id=$1", [authIdentityId]);
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')", [sessionId, createHash("sha256").update(randomUUID()).digest("hex"), authIdentityId, userId, workspaceId]);
      const session: AppSession = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC QA", name: "SYNTHETIC owner", email: `qa-${userId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), authSessionId: sessionId, authIdentityId };
      return { workspaceId, userId, sessionId, session };
    }
    const a = await tenant(), b = await tenant();
    async function draft(owner = a) {
      const id = randomUUID();
      await withCrmRead(owner.session, (tx, fresh) => savePropertyCreationDraft(tx, fresh, { id, draft: emptyPropertyCreationDraft(), step: 0, expectedRevision: 0, requestId: randomUUID() }), options);
      return id;
    }
    async function batch(records: { type: string; id: string; scope?: string }[], owner = a) {
      const id = randomUUID();
      await db.admin.query("insert into qa_batches(id,workspace_id,batch_marker,created_by_user_id) values($1,$2,$3,$4)", [id, owner.workspaceId, `QA-TEST-20261104-2200-${randomUUID().replaceAll("-", "").slice(0, 12)}`, owner.userId]);
      for (const record of records) await register(id, record, owner);
      return id;
    }
    async function register(batchId: string, record: { type: string; id: string; scope?: string }, owner = a) {
      await db.admin.query("insert into qa_batch_objects(workspace_id,batch_id,resource_scope,resource_type,resource_id,created_by_user_id) values($1,$2,$3,$4,$5,$6)", [owner.workspaceId, batchId, record.scope ?? "database", record.type, record.id, owner.userId]);
    }
    const plan = async (batchId: string, owner = a) => (await runQaCleanup(owner.session, { mode: "dry_run", batchId }, metadata(), options)).data as unknown as PlanResponse;
    const executeInput = (p: PlanResponse, batchId: string, owner = a) => ({ mode: "execute", batchId, planId: p.planId, expectedPlanDigest: p.plan.digest, expectedCounts: p.plan.counts, expectedTargets: p.plan.targets.map(({ type, id }) => ({ type, id })), confirmation: `RETIRE QA BATCH ${owner.workspaceId} ${batchId}` });
    const state = async (id: string) => (await db.admin.query("select status,revision from crm_property_creation_drafts where id=$1", [id])).rows[0];
    const denied = (error: unknown) => error instanceof CrmCommandError && [401, 403, 404].includes(error.status);

    await t.test("two tenants: exact registered own draft retires once and survives a new process replay", async () => {
      const id = await draft(), otherId = await draft(b), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      const p = await plan(batchId); assert.equal(p.outcome, "dry_run"); assert.deepEqual(p.plan.blockers, []);
      const input = executeInput(p, batchId), key = metadata();
      const first = await runQaCleanup(a.session, input, key, options);
      assert.equal(first.data.outcome, "executed"); assert.deepEqual(first.data.retiredCounts, { crm_property_creation_drafts: 1 }); assert.deepEqual(first.data.deletedCounts, {});
      assert.deepEqual(await state(id), { status: "discarded", revision: 2 }); assert.equal((await state(otherId)).status, "active");
      const file = path.join(db.directory, "synthetic-cleanup-replay.json");
      await writeFile(file, JSON.stringify({ marker: "SYNTHETIC_QA_CLEANUP_REPLAY", port: db.port, role: db.role, session: a.session, request: input, metadata: key }));
      const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
      const output = execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/lib/qa-cleanup-replay-worker.ts", file], { cwd: process.cwd(), env: { ...env, NODE_ENV: "test" }, windowsHide: true, timeout: 45_000, encoding: "utf8" });
      const replay = JSON.parse(output); assert.equal(replay.replayed, true); assert.equal(replay.commandId, first.commandId); assert.equal(replay.data.outcome, "executed"); assert.deepEqual(await state(id), { status: "discarded", revision: 2 });
      const alternateKey = await runQaCleanup(a.session, input, metadata(), options); assert.equal(alternateKey.data.outcome, "executed"); assert.equal(alternateKey.data.auditId, first.data.auditId); assert.deepEqual(await state(id), { status: "discarded", revision: 2 });
      const executed = await db.admin.query("select count(*)::int as n from qa_reset_audit_events where batch_id=$1 and outcome='executed'", [batchId]); assert.equal(executed.rows[0].n, 1);
    });
    await t.test("non-QA marker is denied without automatic adoption", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      await db.admin.query("update workspaces set is_qa=false where id=$1", [a.workspaceId]);
      try { await assert.rejects(plan(batchId), denied); assert.equal((await state(id)).status, "active"); }
      finally { await db.admin.query("update workspaces set is_qa=true where id=$1", [a.workspaceId]); }
    });
    await t.test("foreign batch does not leak or act", async () => {
      const id = await draft(b), batchId = await batch([{ type: "crm_property_creation_drafts", id }], b);
      await assert.rejects(plan(batchId), denied); assert.equal((await state(id)).status, "active");
    });
    await t.test("foreign registered ID stays unavailable and blocks the entire plan", async () => {
      const id = await draft(b), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      const p = await plan(batchId); assert.equal(p.outcome, "blocked"); assert.ok(p.plan.blockers.some(x => x.code === "QA_REGISTERED_OBJECT_UNAVAILABLE")); assert.equal((await state(id)).status, "active");
    });
    await t.test("accounts, tenant rows, audit, settings and provider resources are never adopted", async () => {
      for (const type of ["workspace_users", "workspaces", "audit_logs", "settings", "provider_event"]) {
        const id = randomUUID(), batchId = await batch([{ type, id, ...(type === "provider_event" ? { scope: "provider" } : {}) }]);
        const p = await plan(batchId); assert.equal(p.outcome, "blocked"); assert.ok(p.plan.blockers.some(x => x.code === "QA_RESOURCE_UNSUPPORTED"));
      }
      assert.equal((await db.admin.query("select status from workspace_users where id=$1", [a.userId])).rows[0].status, "active");
    });
    await t.test("digest, count, target ID and confirmation mismatch cannot mutate", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]), p = await plan(batchId), input = executeInput(p, batchId);
      for (const change of [{ expectedPlanDigest: "f".repeat(64) }, { expectedCounts: { crm_property_creation_drafts: 2 } }, { expectedTargets: [{ type: "crm_property_creation_drafts", id: randomUUID() }] }, { confirmation: "RESET EVERYTHING" }]) await assert.rejects(runQaCleanup(a.session, { ...input, ...change }, metadata(), options), error => error instanceof CrmCommandError && error.code === "QA_PLAN_MISMATCH");
      assert.equal((await state(id)).status, "active");
    });
    await t.test("changed row invalidates plan without partially retiring its peer", async () => {
      const first = await draft(), second = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id: first }, { type: "crm_property_creation_drafts", id: second }]), p = await plan(batchId);
      await withCrmRead(a.session, (tx, fresh) => savePropertyCreationDraft(tx, fresh, { id: second, draft: { ...emptyPropertyCreationDraft(), title: "SYNTHETIC changed" }, step: 0, expectedRevision: 1, requestId: randomUUID() }), options);
      const result = await runQaCleanup(a.session, executeInput(p, batchId), metadata(), options); assert.equal(result.data.outcome, "blocked"); assert.equal((await state(first)).status, "active"); assert.equal((await state(second)).status, "active");
    });
    await t.test("late registration invalidates plan", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]), p = await plan(batchId), late = await draft();
      await register(batchId, { type: "crm_property_creation_drafts", id: late });
      const result = await runQaCleanup(a.session, executeInput(p, batchId), metadata(), options); assert.equal(result.data.outcome, "blocked"); assert.equal((await state(id)).status, "active"); assert.equal((await state(late)).status, "active");
    });
    await t.test("stored role revocation defeats both plan and successful receipt replay", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]), p = await plan(batchId), input = executeInput(p, batchId), key = metadata();
      await runQaCleanup(a.session, input, key, options);
      await db.admin.query("update workspace_users set product_role='viewer' where id=$1", [a.userId]);
      try { await assert.rejects(plan(batchId), denied); await assert.rejects(runQaCleanup(a.session, input, key, options), denied); }
      finally { await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [a.userId]); }
    });
    await t.test("revoked stored session defeats stale caller claims", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      await db.admin.query("update auth_sessions set revoked_at=now(),revoked_reason='SYNTHETIC_TEST' where id=$1", [a.sessionId]);
      try { await assert.rejects(plan(batchId), denied); }
      finally { await db.admin.query("update auth_sessions set revoked_at=null,revoked_reason=null where id=$1", [a.sessionId]); }
    });
    await t.test("194 owner stays NOLOGIN/NOINHERIT/NOBYPASSRLS and runtime cannot update or assume it", async () => {
      const rights = (await db.admin.query("select rolcanlogin as login,rolinherit as inherit,rolsuper as super,rolcreatedb as createdb,rolcreaterole as createrole,rolreplication as replication,rolbypassrls as bypass from pg_roles where rolname='novalure_qa_batch_locker'")).rows[0];
      assert.deepEqual(rights, { login: false, inherit: false, super: false, createdb: false, createrole: false, replication: false, bypass: false });
      const policy = (await db.admin.query("select relrowsecurity as rls,relforcerowsecurity as forced from pg_class where oid='qa_batches'::regclass")).rows[0]; assert.deepEqual(policy, { rls: true, forced: true });
      const acl = (await db.admin.query("select has_column_privilege($1,'qa_batches','id','UPDATE') as update,pg_has_role($1,'novalure_qa_batch_locker','MEMBER') as member,has_function_privilege($1,'crm_qa_lock_registered_batch(uuid,uuid)','EXECUTE') as execute", [db.role])).rows[0]; assert.deepEqual(acl, { update: false, member: false, execute: true });
      await assert.rejects(withCrmRead(a.session, tx => tx.execute("update qa_batches set id=id where workspace_id=$1", [a.workspaceId]), options), error => (error as { code?: string }).code === "42501");
      const client = await db.pool.connect();
      try { await client.query("begin"); await assert.rejects(client.query("set local role novalure_qa_batch_locker"), error => (error as { code?: string }).code === "42501"); }
      finally { await client.query("rollback"); client.release(); }
    });
    await t.test("194 owner row visibility is exact-tenant and append-only trigger also denies owner DML", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      const client = await db.admin.connect();
      try {
        await client.query("begin"); await client.query("set local role novalure_qa_batch_locker");
        await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [a.workspaceId, a.userId]);
        const foreign = await client.query("select id from qa_batches where workspace_id=$1", [b.workspaceId]); assert.equal(foreign.rows.length, 0);
        await assert.rejects(client.query("update qa_batches set id=id where id=$1", [batchId]), error => (error as { code?: string }).code === "55000");
      } finally { await client.query("rollback"); client.release(); }
    });
    await t.test("194 direct function rejects foreign tenant arguments and current non-admin", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      await assert.rejects(withCrmRead(a.session, tx => tx.queryOne("select * from crm_qa_lock_registered_batch($1,$2)", [b.workspaceId, batchId]), options), error => (error as { code?: string }).code === "42501");
      await db.admin.query("update workspace_users set product_role='viewer' where id=$1", [a.userId]);
      try { await assert.rejects(withCrmRead(a.session, tx => tx.queryOne("select * from crm_qa_lock_registered_batch($1,$2)", [a.workspaceId, batchId]), options), error => (error as { code?: string }).code === "42501"); }
      finally { await db.admin.query("update workspace_users set product_role='customer_owner' where id=$1", [a.userId]); }
    });
    await t.test("batch FK lock excludes concurrent new registrations", async () => {
      const id = await draft(), late = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const holder = withCrmRead(a.session, async tx => { await tx.queryOne("select * from crm_qa_lock_registered_batch($1,$2)", [a.workspaceId, batchId]); entered(); await held; }, options);
      try {
        await locked;
        const client = await db.admin.connect();
        try {
          await client.query("begin"); await client.query("set local lock_timeout='200ms'");
          await assert.rejects(client.query("insert into qa_batch_objects(workspace_id,batch_id,resource_scope,resource_type,resource_id,created_by_user_id) values($1,$2,'database','crm_property_creation_drafts',$3,$4)", [a.workspaceId, batchId, late, a.userId]), error => (error as { code?: string }).code === "55P03");
        } finally { await client.query("rollback"); client.release(); }
      } finally { release(); await holder; }
      await register(batchId, { type: "crm_property_creation_drafts", id: late });
    });
    await t.test("expired first-execution plan cannot mutate", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]), p = await plan(batchId), oldPlanId = randomUUID();
      // Append a separately marked synthetic old plan; never alter an existing
      // immutable audit row or disable its trigger to manufacture the clock.
      await db.admin.query("insert into qa_reset_audit_events(id,workspace_id,batch_id,actor_user_id,mode,outcome,plan_digest,target_counts,target_manifest,blocker_codes,occurred_at) select $1,workspace_id,batch_id,actor_user_id,mode,outcome,plan_digest,target_counts,target_manifest,blocker_codes,now()-interval '16 minutes' from qa_reset_audit_events where id=$2", [oldPlanId, p.planId]);
      await assert.rejects(runQaCleanup(a.session, { ...executeInput(p, batchId), planId: oldPlanId }, metadata(), options), error => error instanceof CrmCommandError && error.code === "QA_PLAN_EXPIRED"); assert.equal((await state(id)).status, "active");
    });
    await t.test("registered parent cannot implicitly adopt an unregistered supported successor", async () => {
      await db.admin.query("alter table crm_property_creation_drafts add constraint synthetic_cleanup_pair unique(workspace_id,id)");
      await db.admin.query("alter table crm_property_creation_drafts add column synthetic_parent_draft_id uuid");
      await db.admin.query("alter table crm_property_creation_drafts add foreign key(workspace_id,synthetic_parent_draft_id) references crm_property_creation_drafts(workspace_id,id)");
      const parent = await draft(), child = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id: parent }]);
      await db.admin.query("update crm_property_creation_drafts set synthetic_parent_draft_id=$1,revision=revision+1 where id=$2", [parent, child]);
      const p = await plan(batchId); assert.equal(p.outcome, "blocked"); assert.ok(p.plan.blockers.some(x => x.code === "QA_UNREGISTERED_SUCCESSOR")); assert.equal((await state(parent)).status, "active");
    });
    await t.test("unregistered successor and unproven foreign relation block closed", async () => {
      const id = await draft(), batchId = await batch([{ type: "crm_property_creation_drafts", id }]);
      await db.admin.query("create table synthetic_cleanup_successors(id uuid primary key,workspace_id uuid not null,draft_id uuid not null,foreign key(workspace_id,draft_id) references crm_property_creation_drafts(workspace_id,id))");
      await db.admin.query("alter table synthetic_cleanup_successors enable row level security"); await db.admin.query("alter table synthetic_cleanup_successors force row level security"); await db.admin.query("create policy synthetic_cleanup_tenant on synthetic_cleanup_successors to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid)"); await db.admin.query("grant select on synthetic_cleanup_successors to novalure_tenant_app");
      await db.admin.query("insert into synthetic_cleanup_successors values($1,$2,$3)", [randomUUID(), a.workspaceId, id]);
      const p = await plan(batchId); assert.equal(p.outcome, "blocked"); assert.ok(p.plan.blockers.some(x => x.code === "QA_DEPENDENCY_TYPE_UNSUPPORTED")); assert.equal((await state(id)).status, "active");
      await db.admin.query("create table synthetic_unscoped_cleanup_successors(id uuid primary key,workspace_id uuid not null,draft_id uuid references crm_property_creation_drafts(id))");
      await db.admin.query("insert into synthetic_unscoped_cleanup_successors values($1,$2,$3)", [randomUUID(), b.workspaceId, id]);
      const unsafe = await plan(batchId); assert.equal(unsafe.outcome, "blocked"); assert.ok(unsafe.plan.blockers.some(x => x.code === "QA_DEPENDENCY_SCHEMA_UNPROVEN")); assert.equal(JSON.stringify(unsafe).includes(b.workspaceId), false);
    });
    await t.test("ledger and audit remain append-only; no business rows were deleted", async () => {
      const before = await db.admin.query("select (select count(*) from qa_batches)::int as batches,(select count(*) from qa_batch_objects)::int as objects,(select count(*) from qa_reset_audit_events)::int as events,(select count(*) from audit_logs)::int as audits");
      for (const table of ["qa_batches", "qa_batch_objects", "qa_reset_audit_events", "audit_logs"]) await assert.rejects(db.admin.query(`delete from ${table}`));
      const after = await db.admin.query("select (select count(*) from qa_batches)::int as batches,(select count(*) from qa_batch_objects)::int as objects,(select count(*) from qa_reset_audit_events)::int as events,(select count(*) from audit_logs)::int as audits"); assert.deepEqual(after.rows, before.rows);
      assert.equal((await db.admin.query("select count(*)::int as n from workspace_users where id=any($1::uuid[])", [[a.userId, b.userId]])).rows[0].n, 2);
    });
  } finally { globalThis.fetch = originalFetch; await db.stop(); }
});
