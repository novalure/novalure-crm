import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { handleCrmContractRequest } from "../src/lib/crm-service-contract";
import {
  CRM_PRODUCTION_CANARY,
  CRM_PRODUCTION_WORKSPACE_ID,
  CrmMachineAuthError,
  verifyCrmMachineToken,
} from "../src/lib/crm-machine-auth";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { getRequestSession } from "../src/lib/auth/session";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const issuer = "https://identity.example.invalid/evelyn";
const audience = "urn:novalure:crm:production";
const subject = "workload:evelyn:crm:production";
const keyId = "evelyn-crm-key-v1";
const identityId = "EVELYN_CRM_SERVICE_IDENTITY";
const actorId = randomUUID();
const projectId = randomUUID();
const contactId = randomUUID();
const principalId = randomUUID();
const capabilities = ["crm.contacts.read", "crm.contacts.write"];
const now = new Date("2026-10-05T20:00:00.000Z");
const runtimeEnv = {
  CRM_SERVICE_IDENTITY_AUDIENCE: audience,
  CRM_SERVICE_IDENTITY_ISSUER: issuer,
  CRM_SERVICE_IDENTITY_JWKS_URL: "https://identity.example.invalid/.well-known/jwks.json",
  CRM_SERVICE_IDENTITY_PRODUCTION_ENABLED: "1",
  NODE_ENV: "production",
  VERCEL_ENV: "production",
} as NodeJS.ProcessEnv;

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
const pool = () => db.pool as unknown as TenantPool;

type ClaimsOverride = Record<string, unknown> & { issuer?: string; audience?: string; keyId?: string; issuedAt?: number; expiresAt?: number };

async function token(overrides: ClaimsOverride = {}, signingKey: CryptoKey = privateKey) {
  const issuedAt = overrides.issuedAt ?? Math.floor(now.valueOf() / 1000);
  const expiresAt = overrides.expiresAt ?? issuedAt + 120;
  const tokenIssuer = overrides.issuer ?? issuer;
  const tokenAudience = overrides.audience ?? audience;
  const tokenKeyId = overrides.keyId ?? keyId;
  const custom = Object.fromEntries(Object.entries(overrides).filter(([name]) => !["issuer", "audience", "keyId", "issuedAt", "expiresAt"].includes(name)));
  return new SignJWT({
    capabilities,
    consumer: "EVELYN",
    environment: "PRODUCTION",
    role: "Evelyn.Service",
    service_identity_id: identityId,
    tenant_id: CRM_PRODUCTION_WORKSPACE_ID,
    workspace_id: CRM_PRODUCTION_WORKSPACE_ID,
    ...custom,
  })
    .setProtectedHeader({ alg: "ES256", kid: tokenKeyId, typ: "JWT" })
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setSubject(subject)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey);
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "crm-integration-v1",
    environment: "PRODUCTION",
    synthetic: true,
    operation: "Read",
    entity: "Contact",
    tenantId: CRM_PRODUCTION_WORKSPACE_ID,
    resourceId: CRM_PRODUCTION_CANARY,
    actorId: "evelyn",
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
    expectedVersion: null,
    approvalReference: null,
    auditReference: randomUUID(),
    validation: { status: "VALIDATED", schemaVersion: "crm-integration-v1" },
    patch: {},
    ...overrides,
  };
}

async function call(body: Record<string, unknown>, bearer?: string) {
  const authorization = bearer ?? await token();
  const response = await handleCrmContractRequest(new Request("https://crm.novalure.example/api/crm/contract/v1", {
    method: "POST",
    headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { pool: pool(), machineAuth: { env: runtimeEnv, jwks, now } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

before(async () => {
  const primary = await generateKeyPair("ES256", { extractable: true });
  const other = await generateKeyPair("ES256", { extractable: true });
  privateKey = primary.privateKey;
  otherPrivateKey = other.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(primary.publicKey), alg: "ES256", kid: keyId, use: "sig" }] });
  db = await startLocalSalesDb();
  await applySalesSchema(db);
  await db.admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC Production machine auth','managed_by_novalure','{}')", [CRM_PRODUCTION_WORKSPACE_ID]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Evelyn Service Identity','evelyn-service@example.invalid','agent','project_sales_member','active')", [actorId, CRM_PRODUCTION_WORKSPACE_ID]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC: Machine project','SYNTHETIC: Service')", [projectId, CRM_PRODUCTION_WORKSPACE_ID]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [CRM_PRODUCTION_WORKSPACE_ID, projectId, actorId]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role,data_classification) values($1,$2,$3,'SYNTHETIC: Evelyn machine proof','machine-proof@example.invalid','Bauträger','CUSTOMER_TENANT')", [contactId, CRM_PRODUCTION_WORKSPACE_ID, projectId]);
  await db.admin.query(
    `insert into crm_service_principals(id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,data_context,data_classification,purpose,environment,synthetic,expires_at,identity_id,service_subject,consumer,service_role,auth_type,issuer,audience,secret_reference,state,accepted_key_ids,credential_version,not_before)
     values($1::uuid,$2::uuid,$3::uuid,null,$2::text,'evelyn',$4,'CUSTOMER_TENANT','CONFIDENTIAL','OPERATIONS','PRODUCTION',false,$5,$6,$7,'EVELYN','Evelyn.Service','OIDC_JWKS',$8,$9,'EVELYN_CRM_SERVICE_CREDENTIAL_REFERENCE','ACTIVE',$10,1,$11)`,
    [principalId, CRM_PRODUCTION_WORKSPACE_ID, actorId, capabilities, new Date(now.valueOf() + 86_400_000), identityId, subject, issuer, audience, [keyId], new Date(now.valueOf() - 60_000)],
  );
  await db.admin.query("insert into crm_service_resource_bindings(principal_id,workspace_id,resource_alias,entity,source_id,project_id,data_context,data_classification,domain,purpose) values($1,$2,$3,'Contact',$4,$5,'CUSTOMER_TENANT','CONFIDENTIAL','BUSINESS','OPERATIONS')", [principalId, CRM_PRODUCTION_WORKSPACE_ID, CRM_PRODUCTION_CANARY, contactId, projectId]);
});

after(async () => {
  await closeLocalTestPool();
  if (db) await db.stop();
});

test("machine JWT: correct signed Production identity and all exact claims are accepted", async () => {
  const claims = await verifyCrmMachineToken(await token(), { env: runtimeEnv, jwks, now });
  assert.equal(claims.identityId, identityId);
  assert.equal(claims.workspaceId, CRM_PRODUCTION_WORKSPACE_ID);
  assert.equal(claims.consumer, "EVELYN");
  assert.equal(claims.environment, "PRODUCTION");
  assert.equal(claims.role, "Evelyn.Service");
  assert.deepEqual(claims.capabilities, capabilities);
});

test("machine JWT: malformed, expired, bad signature, issuer, audience, consumer, environment and tenant are denied", async () => {
  const invalid = [
    "malformed",
    await token({}, otherPrivateKey),
    await token({ expiresAt: Math.floor(now.valueOf() / 1000) - 60 }),
    await token({ issuer: "https://other.example.invalid" }),
    await token({ audience: "urn:other" }),
    await token({ consumer: "OTHER" }),
    await token({ environment: "PREVIEW" }),
    await token({ tenant_id: randomUUID() }),
    await token({ workspace_id: randomUUID() }),
    await token({ role: "Owner" }),
  ];
  for (const candidate of invalid) {
    await assert.rejects(verifyCrmMachineToken(candidate, { env: runtimeEnv, jwks, now }), CrmMachineAuthError);
  }
});

test("machine HTTP: no auth, cookies, malformed token and disabled enablement fail closed", async () => {
  const body = envelope();
  const noAuth = await handleCrmContractRequest(new Request("https://crm.novalure.example/api/crm/contract/v1", { method: "POST", body: JSON.stringify(body) }), { pool: pool(), machineAuth: { env: runtimeEnv, jwks, now } });
  assert.equal(noAuth.status, 401);
  const cookie = await handleCrmContractRequest(new Request("https://crm.novalure.example/api/crm/contract/v1", { method: "POST", headers: { authorization: `Bearer ${await token()}`, cookie: "novalure_session=forged" }, body: JSON.stringify(body) }), { pool: pool(), machineAuth: { env: runtimeEnv, jwks, now } });
  assert.equal(cookie.status, 403);
  const malformed = await call(body, "malformed");
  assert.equal(malformed.status, 401);
  const disabled = await handleCrmContractRequest(new Request("https://crm.novalure.example/api/crm/contract/v1", { method: "POST", headers: { authorization: `Bearer ${await token()}` }, body: JSON.stringify(body) }), { pool: pool(), machineAuth: { env: { ...runtimeEnv, CRM_SERVICE_IDENTITY_PRODUCTION_ENABLED: "0" }, jwks, now } });
  assert.equal(disabled.status, 403);
});

test("machine HTTP: Production canary read is tenant/RLS bound and emits a service audit actor", async () => {
  const response = await call(envelope());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body.projection as { sourceId: string }).sourceId, contactId);
  assert.equal(typeof response.body.serviceAuditReference, "string");
  assert.doesNotMatch(JSON.stringify(response.body), /machine-proof@example|token_hash|secret_reference/);
  const audit = (await db.admin.query("select actor_type,identity_id,service_role,consumer,environment,correlation_id,action,object_id,outcome from crm_service_audit_events order by occurred_at desc limit 1")).rows[0];
  assert.deepEqual({ actorType: audit.actor_type, identity: audit.identity_id, role: audit.service_role, consumer: audit.consumer, environment: audit.environment, action: audit.action, objectId: audit.object_id, outcome: audit.outcome }, { actorType: "SERVICE_IDENTITY", identity: identityId, role: "Evelyn.Service", consumer: "EVELYN", environment: "PRODUCTION", action: "crm.contacts.read", objectId: contactId, outcome: "SUCCESS" });
  await assert.rejects(db.pool.query("select identity_id from crm_service_audit_events"), /permission denied/);
  await assert.rejects(db.admin.query("update crm_service_audit_events set outcome='DENIED'"), /immutable/);
});

test("machine HTTP: bounded synthetic write works but Proposal/Contract A3 and permission operations are denied", async () => {
  const update = envelope({ operation: "Update", expectedVersion: 1, patch: { name: "SYNTHETIC: Evelyn machine update" } });
  const written = await call(update);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const commandAudit = (await db.admin.query("select after from audit_logs where action='contract.v1.contact.update' order by created_at desc limit 1")).rows[0].after;
  assert.equal(commandAudit.actor.actorType, "SERVICE_IDENTITY");
  assert.equal(commandAudit.actor.identityId, identityId);
  for (const body of [
    envelope({ operation: "SendOffer", entity: "Offer", approvalReference: randomUUID() }),
    envelope({ operation: "ConfirmSale", entity: "Sale", approvalReference: randomUUID() }),
    envelope({ operation: "Update", entity: "ApprovalReference", resourceId: CRM_PRODUCTION_CANARY, expectedVersion: 1, patch: { name: "SYNTHETIC: permission" } }),
  ]) assert.equal((await call(body)).status, 400);
  const humanRouteSession = await getRequestSession(new Request("https://crm.novalure.example/api/crm/customer-access", { headers: { authorization: `Bearer ${await token()}`, "x-novalure-role": "owner", "x-novalure-user-id": actorId, "x-novalure-workspace-id": CRM_PRODUCTION_WORKSPACE_ID } }));
  assert.equal(humanRouteSession, null, "machine JWT must never become a human/Owner session");
});

test("machine registry: revoked, expired, disabled, wrong key and excess claims fail closed; overlap enables rotation", async () => {
  for (const state of ["REVOKED", "EXPIRED", "DISABLED"]) {
    await db.admin.query("update crm_service_principals set state=$2 where id=$1", [principalId, state]);
    assert.equal((await call(envelope())).status, 401);
  }
  await db.admin.query("update crm_service_principals set state='ACTIVE' where id=$1", [principalId]);
  assert.equal((await call(envelope(), await token({ capabilities: ["crm.contacts.read", "crm.identity.manage"] }))).status, 401);
  assert.equal((await call(envelope(), await token({ keyId: "not-registered" }))).status, 401);
  await db.admin.query("update crm_service_principals set accepted_key_ids=array[$2,$3],credential_version=2,rotation_overlap_until=now()+interval '5 minutes' where id=$1", [principalId, keyId, "evelyn-crm-key-v2"]);
  assert.equal((await call(envelope())).status, 200);
  await db.admin.query("update crm_service_principals set accepted_key_ids=array[$2],rotation_overlap_until=null where id=$1", [principalId, "evelyn-crm-key-v2"]);
  assert.equal((await call(envelope())).status, 401);
  await db.admin.query("update crm_service_principals set accepted_key_ids=array[$2],credential_version=1 where id=$1", [principalId, keyId]);
});

test("machine kill switches: global, CRM, tenant and action stops override valid authentication", async () => {
  for (const stop of [
    { scope: "GLOBAL", workspace: null, action: null },
    { scope: "CRM", workspace: null, action: null },
    { scope: "TENANT", workspace: CRM_PRODUCTION_WORKSPACE_ID, action: null },
    { scope: "ACTION", workspace: CRM_PRODUCTION_WORKSPACE_ID, action: "crm.contacts.read" },
  ]) {
    const inserted = (await db.admin.query("insert into crm_service_kill_switches(scope,workspace_id,capability,reason) values($1,$2,$3,'synthetic test stop') returning id", [stop.scope, stop.workspace, stop.action])).rows[0].id;
    const response = await call(envelope());
    assert.ok([401, 403].includes(response.status), `${stop.scope}:${JSON.stringify(response.body)}`);
    await db.admin.query("update crm_service_kill_switches set active=false where id=$1", [inserted]);
  }
});

test("machine database role is NOBYPASSRLS and wrong/no tenant context cannot read canary data", async () => {
  const role = (await db.admin.query("select rolsuper,rolbypassrls,rolcreaterole from pg_roles where rolname=$1", [db.role])).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  assert.equal((await db.pool.query("select name from contacts where id=$1", [contactId])).rows.length, 0);
  assert.equal((await call(envelope({ tenantId: randomUUID() }))).status, 400);
  await assert.rejects(db.pool.query("update crm_service_principals set scopes=array['crm.contacts.read'] where id=$1", [principalId]), /permission denied/);
  await assert.rejects(db.pool.query("insert into crm_service_kill_switches(scope,reason) values('GLOBAL','disable audit')"), /permission denied/);
  await assert.rejects(db.pool.query(`alter role ${db.role} bypassrls`), /permission denied/);
});
