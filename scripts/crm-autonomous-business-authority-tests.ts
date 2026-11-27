import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { decideAutonomousBusinessAuthority, assertAndConsumeAutonomousBusinessAuthority } from "../src/lib/crm-autonomous-business-authority";
import { registerAutonomousCrmAccess } from "../src/lib/crm-autonomous-registration";
import { autonomousModuleContract, type AutonomousModuleRequest } from "../src/lib/crm-autonomous-module-contract";
import type { AutonomousModuleGrant } from "../src/lib/crm-autonomous-module-storage";
import type { AppSession } from "../src/lib/auth/session";
import { crmPayloadDigest } from "../src/lib/crm-command";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { CRM_MACHINE_WORKSPACE_ID } from "../src/lib/crm-machine-auth";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const ownerId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), workloadId = randomUUID(), taskId = randomUUID(), contactId = randomUUID();
const ownerSessionId = randomUUID(); let identityId: string, owner: AppSession, service: AppSession;
const keys = generateKeyPairSync("ed25519"), installer = "autonomous_business_installer";
const options = () => ({ pool: db.pool as unknown as TenantPool });

before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 90 });
  await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC business authority','novalure_internal','novalure_internal',$2::jsonb) on conflict(id) do update set operating_model='novalure_internal',setup_state=excluded.setup_state", [CRM_MACHINE_WORKSPACE_ID, JSON.stringify({ salesApprovalUserId: ownerId })]);
  for (const [id, name, role, productRole] of [[ownerId, "owner", "owner", "platform_admin"], [actorId, "agent", "agent", "novalure_operator"]]) {
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')", [id, CRM_MACHINE_WORKSPACE_ID, `SYNTHETIC ${name}`, `${name}@business-authority.invalid`, role, productRole]);
  }
  identityId = (await db.admin.query("select auth_identity_id from workspace_users where id=$1", [ownerId])).rows[0].auth_identity_id;
  await db.admin.query("update auth_identities set credential_state='active',mfa_enabled_at=clock_timestamp(),mfa_secret_ciphertext='SYNTHETIC_NONUSABLE_MFA_FIXTURE' where id=$1", [identityId]);
  await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 hour')", [ownerSessionId, createHash("sha256").update(randomUUID()).digest("hex"), identityId, ownerId, CRM_MACHINE_WORKSPACE_ID]);
  await db.admin.query("insert into projects(id,workspace_id,name,type,status) values($1,$2,'SYNTHETIC authority project','Internal','Aktiv')", [projectId, CRM_MACHINE_WORKSPACE_ID]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [CRM_MACHINE_WORKSPACE_ID, projectId, actorId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC buyer','Käufer')", [contactId, CRM_MACHINE_WORKSPACE_ID, projectId]);
  await db.admin.query(`create role ${installer} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  await db.admin.query(`grant usage,create on schema public to ${installer}; grant references on projects,auth_identities,auth_sessions to ${installer}; grant execute on function crm_reject_immutable_mutation() to ${installer}`);
  await db.admin.query(`grant select(id,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,created_at,revoked_at,expires_at) on auth_sessions to ${installer}; grant update(last_seen_at) on auth_sessions to ${installer}`);
  await db.admin.query(`grant select(id,credential_state,disabled_at,mfa_enabled_at,normalized_email) on auth_identities to ${installer}; grant update(updated_at) on auth_identities to ${installer}`);
  for (const table of ["workspaces", "workspace_users", "project_pipeline_permissions", "calendar_events", "conversations", "contacts", "crm_offers", "crm_offer_revisions", "property_reservations", "property_units", "property_sales"]) {
    await db.admin.query(`alter table ${table} owner to ${installer}`);
  }
  const connection = await db.admin.connect();
  try {
    await connection.query(`set role ${installer}`);
    for (const stage of ["evelyn_autonomous_access.sql", "evelyn_autonomous_personal_source.sql", "evelyn_autonomous_modules.sql", "evelyn_autonomous_business_authority.sql"]) {
      await connection.query("begin");
      try { await connection.query(await readFile(`migrations/staged/${stage}`, "utf8")); await connection.query("commit"); }
      catch (error) { await connection.query("rollback"); throw error; }
    }
  } finally { await connection.query("reset role"); connection.release(); }
  owner = { authenticated: true, userId: ownerId, workspaceId: CRM_MACHINE_WORKSPACE_ID, workspaceName: "SYNTHETIC", email: "owner@business-authority.invalid", name: "SYNTHETIC owner",
    role: "owner", productRole: "platform_admin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("platform_admin"),
    source: "cookie", authSessionId: ownerSessionId, authIdentityId: identityId, mfaVerifiedAt: new Date(), sessionCreatedAt: new Date() };
  service = { ...owner, userId: actorId, role: "agent", productRole: "novalure_operator", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("novalure_operator"), source: "database",
    authSessionId: undefined, authIdentityId: undefined, serviceIdentity: { identityId: "EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY", role: "Evelyn.Service", consumer: "EVELYN", environment: "production", jtiHash: "a".repeat(64) } };
});
after(async () => { await closeLocalTestPool(); if (db) await db.stop(); });

async function scenario() {
  const unitId = randomUUID(), reservationId = randomUUID(), grantId = randomUUID(), decisionId = randomUUID();
  await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,price_cents) values($1,$2,$3,$4,'available',10000)", [unitId, CRM_MACHINE_WORKSPACE_ID, projectId, `SYNTHETIC-${unitId}`]);
  await db.admin.query("insert into property_reservations(id,workspace_id,project_id,unit_id,contact_id,status,expires_at) values($1,$2,$3,$4,$5,'requested',clock_timestamp()+interval '1 day')", [reservationId, CRM_MACHINE_WORKSPACE_ID, projectId, unitId, contactId]);
  const connection = await db.admin.connect();
  try {
    await connection.query(`set role ${installer}`);
    await registerAutonomousCrmAccess(connection, { workloadId, workloadActorId: actorId, grantId, actorId, projectId, sourceId: reservationId,
      taskId, departmentId: "SALES", agentId: "SYNTHETIC.sales.business", entity: "Reservation", scopes: ["crm.reservations.read", "crm.reservations.confirm"],
      publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), authorityReference: "SYNTHETIC local authority test", expiresAt: null,
      module: { contractVersion: autonomousModuleContract, lifecycleMode: "EXISTING", readFields: ["unitId", "status"], writeFields: [], relatedResources: { unitId } } });
  } finally { await connection.query("reset role"); connection.release(); }
  const grant = (await db.admin.query("select * from crm_autonomous_access_grants where id=$1", [grantId])).rows[0] as AutonomousModuleGrant;
  const command: AutonomousModuleRequest = { contractVersion: autonomousModuleContract, operation: "ConfirmReservation", correlationId: randomUUID(), idempotencyKey: randomUUID(), expectedVersion: 1,
    patch: { approvalReference: decisionId, unitVersion: 1, sourceReference: "SYNTHETIC authorized source confirmation" } };
  const decision = { decision: "APPROVED" as const, decisionId, grantId, command, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { unitId, reservationId, grant, command, decision, decisionId };
}
async function consume(s: Awaited<ReturnType<typeof scenario>>, body = s.command) {
  return consumeGrant(s.grant, body);
}
async function consumeGrant(grant: AutonomousModuleGrant, body: AutonomousModuleRequest) {
  return withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, tx => assertAndConsumeAutonomousBusinessAuthority(tx, service, grant, body), options());
}
const decisionCount = async (id: string, table = "crm_autonomous_business_decisions") => Number((await db.admin.query(`select count(*) from ${table} where ${table.endsWith("decisions") ? "id" : "decision_id"}=$1`, [id])).rows[0].count);
const authorityDenied = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "APPROVAL_REQUIRED");
const versionDenied = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "VERSION_CONFLICT");

test("actual PostgreSQL owner decision requires configured persisted identity and fresh MFA, not worker flags", async () => {
  const s = await scenario();
  await assert.rejects(decideAutonomousBusinessAuthority(service, s.decision, options()), /OWNER_AUTHENTICATION_REQUIRED|current exact business/);
  await assert.rejects(withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, tx => tx.queryOne(
    "select crm_decide_autonomous_business($1,$2,$3,$4,$5::jsonb,$6,'APPROVED',$7::timestamptz)",
    [ownerSessionId, identityId, s.decisionId, s.grant.id, JSON.stringify(s.command), crmPayloadDigest(s.command), s.decision.expiresAt]), options()), /Fresh configured owner/);
  assert.equal(await decisionCount(s.decisionId), 0);
  await db.admin.query("update auth_sessions set mfa_verified_at=clock_timestamp()-interval '16 minutes' where id=$1", [ownerSessionId]);
  await assert.rejects(decideAutonomousBusinessAuthority({ ...owner, mfaVerifiedAt: new Date() }, s.decision, options()), /Fresh configured owner/);
  await db.admin.query("update auth_sessions set mfa_verified_at=clock_timestamp() where id=$1", [ownerSessionId]);
  const result = await decideAutonomousBusinessAuthority(owner, s.decision, options());
  assert.equal(result.decisionId, s.decisionId); assert.equal(await decisionCount(s.decisionId), 1);
});

test("exact consumption and native-effect failure share a real transaction and immutable one-command replay", async () => {
  const s = await scenario(); await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await assert.rejects(withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, async tx => {
    await assertAndConsumeAutonomousBusinessAuthority(tx, service, s.grant, s.command);
    await tx.execute("update property_reservations set version=version+1 where id=$1", [s.reservationId]);
    throw new Error("SYNTHETIC native effect failed");
  }, options()), /SYNTHETIC native effect failed/);
  assert.equal(await decisionCount(s.decisionId, "crm_autonomous_business_consumptions"), 0);
  const first = await consume(s); assert.equal(first.approvalReference, s.decisionId); assert.equal(first.replayed, false);
  await db.admin.query("update property_reservations set version=version+1 where id=$1", [s.reservationId]);
  const replay = await consume(s); assert.equal(replay.replayed, true);
  assert.equal(await decisionCount(s.decisionId, "crm_autonomous_business_consumptions"), 1);
  await assert.rejects(consume(s, { ...s.command, idempotencyKey: randomUUID() }), authorityDenied);
});

test("wrong tenant/object/version/full payload/hash cannot consume an approved decision", async () => {
  const s = await scenario(); await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await assert.rejects(withTenantTransaction({ workspaceId: randomUUID(), actorId: service.userId }, tx => assertAndConsumeAutonomousBusinessAuthority(tx, service, s.grant, s.command), options()), authorityDenied);
  const other = await scenario(); await assert.rejects(consume(other, s.command), authorityDenied);
  await assert.rejects(consume(s, { ...s.command, expectedVersion: 2 }), authorityDenied);
  await assert.rejects(consume(s, { ...s.command, patch: { ...s.command.patch, sourceReference: "SYNTHETIC changed source" } }), authorityDenied);
  await assert.rejects(withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, tx => tx.queryOne(
    "select * from crm_consume_autonomous_business($1,$2::jsonb,$3)", [s.grant.id, JSON.stringify(s.command), "b".repeat(64)]), options()), /hash differs/);
  await db.admin.query("update property_reservations set version=version+1 where id=$1", [s.reservationId]);
  await assert.rejects(consume(s), versionDenied);
  assert.equal(await decisionCount(s.decisionId, "crm_autonomous_business_consumptions"), 0);
});

test("current grant, decision revocation and owner configuration remain mandatory without a personal runtime login", async () => {
  const s = await scenario(); await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await decideAutonomousBusinessAuthority(owner, { decision: "REVOKE", decisionId: s.decisionId }, options());
  await assert.rejects(consume(s), authorityDenied);
  const g = await scenario(); await decideAutonomousBusinessAuthority(owner, g.decision, options());
  await db.admin.query("update crm_autonomous_access_grants set revoked_at=clock_timestamp() where id=$1", [g.grant.id]);
  await assert.rejects(consume(g), authorityDenied);
  const o = await scenario(); await decideAutonomousBusinessAuthority(owner, o.decision, options());
  await db.admin.query("update workspaces set setup_state=setup_state-'salesApprovalUserId' where id=$1", [service.workspaceId]);
  await assert.rejects(consume(o), authorityDenied);
  await db.admin.query("update workspaces set setup_state=jsonb_build_object('salesApprovalUserId',$2::text) where id=$1", [service.workspaceId, ownerId]);
  // Original human logout does not manufacture a fresh-login dependency for the approved service command.
  await db.admin.query("update auth_sessions set revoked_at=clock_timestamp(),revoked_reason='logout' where id=$1", [ownerSessionId]);
  assert.equal((await consume(o)).replayed, false);
  await db.admin.query("update auth_sessions set revoked_at=null,revoked_reason=null where id=$1", [ownerSessionId]);
});

test("expiry, denied decisions and direct runtime mutation are enforced by PostgreSQL", async () => {
  const s = await scenario();
  await assert.rejects(decideAutonomousBusinessAuthority(owner, { ...s.decision, expiresAt: new Date(Date.now() - 1000).toISOString() }, options()), /Invalid owner decision/);
  await decideAutonomousBusinessAuthority(owner, { ...s.decision, decision: "DENIED" }, options());
  await assert.rejects(consume(s), authorityDenied);
  const expiring = await scenario();
  await decideAutonomousBusinessAuthority(owner, { ...expiring.decision, expiresAt: new Date(Date.now() + 150).toISOString() }, options());
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(consume(expiring), authorityDenied);
  for (const sql of ["insert into crm_autonomous_business_consumptions(decision_id) values($1)",
    "update crm_autonomous_business_decisions set decision='APPROVED' where id=$1", "delete from crm_autonomous_business_decisions where id=$1"]) {
    await assert.rejects(withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, tx => tx.execute(sql, [s.decisionId]), options()), /permission denied/);
  }
  const state = await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in('crm_autonomous_business_decisions','crm_autonomous_business_revocations','crm_autonomous_business_consumptions')");
  assert.equal(state.rows.length, 3); assert.ok(state.rows.every((row: { relrowsecurity: boolean; relforcerowsecurity: boolean }) => row.relrowsecurity && row.relforcerowsecurity));
});

test("database and TypeScript full-command hashes agree and replay cannot alter an immutable owner decision", async () => {
  const s = await scenario();
  const hash = (await db.admin.query("select crm_autonomous_business_body_hash($1::jsonb) as hash", [JSON.stringify(s.command)])).rows[0].hash;
  assert.equal(hash, crmPayloadDigest(s.command));
  const offerBody = { ...s.command, operation: "SendOffer", patch: {} };
  assert.equal((await db.admin.query("select crm_autonomous_business_body_hash($1::jsonb) as hash", [JSON.stringify(offerBody)])).rows[0].hash, crmPayloadDigest(offerBody));
  await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await decideAutonomousBusinessAuthority(owner, s.decision, options());
  assert.equal(await decisionCount(s.decisionId), 1);
  await assert.rejects(decideAutonomousBusinessAuthority(owner, { ...s.decision, decision: "DENIED" }, options()), /already bound/);
  await assert.rejects(db.admin.query("update crm_autonomous_business_decisions set decision='DENIED' where id=$1", [s.decisionId]), /immutable/);
});

test("concurrent separately approved commands serialize source locks and yield one winner and one version conflict", async () => {
  const s = await scenario(), secondId = randomUUID();
  const second: AutonomousModuleRequest = { ...s.command, idempotencyKey: randomUUID(), correlationId: randomUUID(), patch: { ...s.command.patch, approvalReference: secondId } };
  await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await decideAutonomousBusinessAuthority(owner, { ...s.decision, decisionId: secondId, command: second }, options());
  const effect = (body: AutonomousModuleRequest) => withTenantTransaction({ workspaceId: service.workspaceId, actorId: service.userId }, async tx => {
    await assertAndConsumeAutonomousBusinessAuthority(tx, service, s.grant, body);
    await tx.query("select pg_sleep(0.025)");
    await tx.execute("update property_reservations set version=version+1 where id=$1", [s.reservationId]);
    await tx.execute("update property_units set version=version+1 where id=$1", [s.unitId]);
    return "COMMITTED";
  }, options());
  const results = await Promise.allSettled([effect(s.command), effect(second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected");
  assert.ok(failure && failure.status === "rejected" && versionDenied(failure.reason));
  assert.equal((await db.admin.query("select version from property_reservations where id=$1", [s.reservationId])).rows[0].version, "2");
});

async function offerScenario() {
  const organizationId = randomUUID(), leadId = randomUUID(), dealId = randomUUID(), offerId = randomUUID(), grantId = randomUUID();
  const content = { subject: "SYNTHETIC quality subject", recipientName: "SYNTHETIC recipient", recipientEmail: "quality@example.invalid", scope: "SYNTHETIC scope", paymentPlan: "SYNTHETIC plan", discounts: "None", specialTerms: "None", riskComplianceNotes: "SYNTHETIC local fixture", terms: "SYNTHETIC terms", validUntil: new Date(Date.now() + 86_400_000).toISOString(), currency: "EUR", taxBasis: "NET", items: [{ description: "SYNTHETIC item", quantity: 1, unitNetCents: 10000 }] };
  const digest = crmPayloadDigest(content);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC quality company','Unternehmen')", [organizationId, service.workspaceId, projectId]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type) values($1,$2,$3,$4,'Käufer')", [leadId, service.workspaceId, projectId, contactId]);
  await db.admin.query("insert into deals(id,workspace_id,project_id,contact_id,lead_id,organization_id,name) values($1,$2,$3,$4,$5,$6,'SYNTHETIC quality deal')", [dealId, service.workspaceId, projectId, contactId, leadId, organizationId]);
  await db.admin.query("insert into crm_offers(id,workspace_id,project_id,deal_id,contact_id,lead_id,organization_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)", [offerId, service.workspaceId, projectId, dealId, contactId, leadId, organizationId, actorId]);
  await db.admin.query("insert into crm_offer_revisions(workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by) values($1,$2,$3,1,$4::jsonb,$5,10000,$6)", [service.workspaceId, projectId, offerId, JSON.stringify(content), digest, actorId]);
  const connection = await db.admin.connect();
  try {
    await connection.query(`set role ${installer}`);
    await registerAutonomousCrmAccess(connection, { workloadId, workloadActorId: actorId, grantId, actorId, projectId, sourceId: offerId,
      taskId, departmentId: "SALES", agentId: "SYNTHETIC.sales.quality", entity: "Offer", scopes: ["crm.offers.read", "crm.offers.send"],
      publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), authorityReference: "SYNTHETIC local authority test", expiresAt: null,
      module: { contractVersion: autonomousModuleContract, lifecycleMode: "EXISTING", readFields: ["title", "status"], writeFields: [], relatedResources: {} } });
  } finally { await connection.query("reset role"); connection.release(); }
  const grant = (await db.admin.query("select * from crm_autonomous_access_grants where id=$1", [grantId])).rows[0] as AutonomousModuleGrant;
  const command: AutonomousModuleRequest = { contractVersion: autonomousModuleContract, operation: "SendOffer", correlationId: randomUUID(), idempotencyKey: randomUUID(), expectedVersion: 1, patch: {} };
  const decision = { decision: "APPROVED" as const, decisionId: randomUUID(), grantId, command, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { offerId, content, digest, grant, command, decision };
}

test("offer approval does not infer quality; explicit owner quality is separately attributed, exact and revocable", async () => {
  const s = await offerScenario(); await decideAutonomousBusinessAuthority(owner, s.decision, options());
  await assert.rejects(consumeGrant(s.grant, s.command), authorityDenied);
  const quality = { ...s.decision, decision: "ATTEST_OFFER_QUALITY", decisionId: randomUUID() };
  await assert.rejects(decideAutonomousBusinessAuthority(service, quality, options()));
  await decideAutonomousBusinessAuthority(owner, quality, options());
  const first = await consumeGrant(s.grant, s.command);
  assert.equal(first.qualityReference, quality.decisionId); assert.equal(first.qualityOrigin, "OWNER_QUALITY_ATTESTATION");
  const event = (await db.admin.query("select event_type,origin,offer_version,offer_revision,content_digest,actor_user_id from crm_autonomous_offer_quality_events where id=$1", [quality.decisionId])).rows[0];
  assert.equal(event.event_type, "ATTESTED"); assert.equal(event.actor_user_id, ownerId); assert.equal(event.content_digest, s.digest);
  // A native queue transition changes version, not the accepted immutable content revision.
  await db.admin.query("update crm_offers set version=version+1 where id=$1", [s.offerId]);
  assert.equal((await consumeGrant(s.grant, s.command)).replayed, true);
  await decideAutonomousBusinessAuthority(owner, { decision: "REVOKE_OFFER_QUALITY", decisionId: quality.decisionId }, options());
  await assert.rejects(consumeGrant(s.grant, s.command), authorityDenied);
  const q = await offerScenario(); await decideAutonomousBusinessAuthority(owner, q.decision, options());
  await decideAutonomousBusinessAuthority(owner, { ...q.decision, decision: "ATTEST_OFFER_QUALITY", decisionId: randomUUID() }, options());
  await db.admin.query("insert into crm_offer_revisions(workspace_id,project_id,offer_id,revision,content,content_digest,total_net_cents,created_by) values($1,$2,$3,2,$4::jsonb,$5,10000,$6)", [service.workspaceId, projectId, q.offerId, JSON.stringify({ ...q.content, subject: "SYNTHETIC changed version" }), "c".repeat(64), actorId]);
  await db.admin.query("update crm_offers set revision=2,version=version+1 where id=$1", [q.offerId]);
  await assert.rejects(consumeGrant(q.grant, q.command), authorityDenied);
});
