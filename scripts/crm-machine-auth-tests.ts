import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { handleCrmContractRequest } from "../src/lib/crm-service-contract";
import {
  CRM_MACHINE_AUDIENCE,
  CRM_MACHINE_ENVIRONMENT,
  CRM_MACHINE_ISSUER,
  CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_RESOURCE,
  CRM_MACHINE_SUBJECT,
  CRM_MACHINE_WORKSPACE_ID,
  CrmMachineAuthError,
  verifyCrmMachineToken,
  type CrmMachineAuthOptions,
} from "../src/lib/crm-machine-auth";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const now = new Date("2026-10-06T14:00:00.000Z");
const nowSeconds = Math.floor(now.valueOf() / 1000);
const taskId = "2fdefb1e-8690-4a84-bf44-485d9858bab4";
const principalId = "8b3238e9-efea-459f-ac84-a08e2a6ec59b";
const keyId = "vercel-test-key";
const runtimeEnv = {
  CRM_MACHINE_AUTH_ENABLED: "1",
  NODE_ENV: "production",
  VERCEL_ENV: "production",
} as NodeJS.ProcessEnv;
const fakeToken = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const pool = () => db.pool as unknown as TenantPool;
type VerificationResult = Awaited<ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>>;

function verification(overrides: Record<string, unknown> = {}): VerificationResult {
  return {
    payload: {
      aud: CRM_MACHINE_AUDIENCE,
      environment: CRM_MACHINE_ENVIRONMENT,
      exp: nowSeconds + 3600,
      iat: nowSeconds - 5,
      iss: CRM_MACHINE_ISSUER,
      jti: randomUUID(),
      nbf: nowSeconds - 5,
      owner_id: CRM_MACHINE_OWNER_ID,
      project_id: CRM_MACHINE_PROJECT_ID,
      sub: CRM_MACHINE_SUBJECT,
      ...overrides,
    },
    protectedHeader: { alg: "RS256", kid: keyId, typ: "JWT" },
  } as VerificationResult;
}

function authOptions(
  overrides: Record<string, unknown> = {},
  capture?: (value: Parameters<NonNullable<CrmMachineAuthOptions["verifier"]>>[1]) => void,
): CrmMachineAuthOptions {
  return {
    env: runtimeEnv,
    now,
    verifier: async (_token, options) => {
      capture?.(options);
      return verification(overrides);
    },
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "crm-integration-v1",
    environment: "production",
    synthetic: true,
    operation: "Read",
    entity: "Task",
    tenantId: CRM_MACHINE_WORKSPACE_ID,
    resourceId: CRM_MACHINE_RESOURCE,
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

async function call(body: Record<string, unknown>, machineAuth = authOptions()) {
  const response = await handleCrmContractRequest(new Request("https://crm.example.invalid/api/crm/contract/v1", {
    method: "POST",
    headers: { authorization: `Bearer ${fakeToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { pool: pool(), machineAuth });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db);
  await db.admin.query("insert into workspaces(id,name,operating_model,setup_state) values($1,'SYNTHETIC: Evelyn machine workspace','managed_by_novalure','{}') on conflict(id) do update set operating_model='managed_by_novalure'", [CRM_MACHINE_WORKSPACE_ID]);
  await db.admin.query("alter table company_profiles enable row level security; alter table company_profiles force row level security; alter table company_profile_versions enable row level security; alter table company_profile_versions force row level security");
  await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
  await db.admin.query(await readFile("migrations/092_crm_production_machine_identity.sql", "utf8"));
  const bootstrap = await db.admin.query("select id from crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)", ["EVELYN_CRM_SERVICE_IDENTITY", CRM_MACHINE_SUBJECT, CRM_MACHINE_ISSUER, CRM_MACHINE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_WORKSPACE_ID, CRM_MACHINE_ENVIRONMENT, "Evelyn.Service"]);
  assert.equal(bootstrap.rowCount, 1, "machine principal bootstrap must authenticate exactly once");
});

after(async () => {
  await closeLocalTestPool();
  if (db) await db.stop();
});

test("machine token pins Vercel issuer, audience, JWKS verifier, algorithm and exact workload", async () => {
  let options: Parameters<NonNullable<CrmMachineAuthOptions["verifier"]>>[1] | undefined;
  const claims = await verifyCrmMachineToken(fakeToken, authOptions({}, value => { options = value; }));
  assert.equal(claims.subject, CRM_MACHINE_SUBJECT);
  assert.equal(claims.workspaceId, CRM_MACHINE_WORKSPACE_ID);
  assert.ok(options);
  assert.deepEqual(options.algorithms, ["RS256"]);
  assert.equal(options.issuer, CRM_MACHINE_ISSUER);
  assert.equal(options.audience, CRM_MACHINE_AUDIENCE);
  assert.equal(options.projectId, CRM_MACHINE_PROJECT_ID);
  assert.equal(options.ownerId, CRM_MACHINE_OWNER_ID);
  assert.equal(options.requiredClaims?.includes("nbf") && options.requiredClaims.includes("jti"), true);
});

test("machine token rejects malformed, signature failure, claim drift, expiry and unsupported algorithm", async () => {
  await assert.rejects(verifyCrmMachineToken("malformed", authOptions()), CrmMachineAuthError);
  await assert.rejects(verifyCrmMachineToken(fakeToken, { ...authOptions(), verifier: async () => { throw new Error("signature"); } }), CrmMachineAuthError);
  const invalid = [
    { iss: "https://oidc.vercel.com/other" }, { aud: "urn:other" }, { sub: "owner:other" },
    { project_id: "prj_other" }, { owner_id: "team_other" }, { environment: "preview" },
    { exp: nowSeconds - 60 }, { nbf: nowSeconds + 120 }, { jti: "not-a-uuid" },
  ];
  for (const value of invalid) await assert.rejects(verifyCrmMachineToken(fakeToken, authOptions(value)), CrmMachineAuthError);
  await assert.rejects(verifyCrmMachineToken(fakeToken, { ...authOptions(), verifier: async () => ({ ...verification(), protectedHeader: { alg: "ES256", kid: keyId, typ: "JWT" } }) }), CrmMachineAuthError);
});

test("machine HTTP denies missing auth, cookies, wrong tenant/resource/action and unregistered workload", async () => {
  const body = envelope();
  const missing = await handleCrmContractRequest(new Request("https://crm.example.invalid/api/crm/contract/v1", { method: "POST", body: JSON.stringify(body) }), { pool: pool(), machineAuth: authOptions() });
  assert.equal(missing.status, 401);
  const cookie = await handleCrmContractRequest(new Request("https://crm.example.invalid/api/crm/contract/v1", { method: "POST", headers: { authorization: `Bearer ${fakeToken}`, cookie: "session=forged" }, body: JSON.stringify(body) }), { pool: pool(), machineAuth: authOptions() });
  assert.equal(cookie.status, 403);
  assert.equal((await call(envelope({ tenantId: randomUUID() }))).status, 400);
  assert.equal((await call(envelope({ resourceId: "OUT_OF_SCOPE" }))).status, 400);
  assert.equal((await call(envelope({ operation: "ConfirmSale", entity: "Sale", approvalReference: "sim-approval" }))).status, 400);
  assert.equal((await call(body, authOptions({ sub: "owner:novalure:project:unknown:environment:production" }))).status, 401);
});

test("machine read/write/read-after-write preserves audit, receipts and idempotency", async () => {
  const read = await call(envelope());
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const projection = read.body.projection as { sourceId?: unknown };
  assert.equal(projection.sourceId, taskId);

  const idempotencyKey = randomUUID();
  const correlationId = randomUUID();
  const request = envelope({ operation: "Update", expectedVersion: 1, idempotencyKey, correlationId, patch: { title: "SYNTHETIC: Evelyn workload write" } });
  const first = await call(request, authOptions({ jti: randomUUID() }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await call(request, authOptions({ jti: randomUUID() }));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  const conflict = await call({ ...request, auditReference: randomUUID(), patch: { title: "SYNTHETIC: Conflicting workload write" } }, authOptions({ jti: randomUUID() }));
  assert.equal(conflict.status, 409);

  const after = await call(envelope());
  const afterProjection = after.body.projection as { data?: { title?: unknown } };
  assert.equal(afterProjection.data?.title, "SYNTHETIC: Evelyn workload write");
  const counts = (await db.admin.query("select (select count(*) from crm_command_receipts where workspace_id=$1 and operation='contract.v1.task.update') receipts,(select count(*) from audit_logs where workspace_id=$1 and action='contract.v1.task.update') command_audits,(select count(*) from crm_service_audit_bindings where principal_id=$2 and jti_hash is not null) machine_audits", [CRM_MACHINE_WORKSPACE_ID, principalId])).rows[0];
  assert.equal(Number(counts.receipts), 1);
  assert.equal(Number(counts.command_audits), 1);
  assert.ok(Number(counts.machine_audits) >= 4);
});

test("JTI replay, identity kill switch and revocation all deny before effect", async () => {
  const jti = randomUUID();
  const request = envelope();
  assert.equal((await call(request, authOptions({ jti }))).status, 200);
  assert.equal((await call(request, authOptions({ jti }))).status, 409);

  await db.admin.query("update crm_service_principals set kill_switch_active=true,kill_switch_reason='synthetic verification' where id=$1", [principalId]);
  assert.equal((await call(envelope())).status, 401);
  await db.admin.query("update crm_service_principals set kill_switch_active=false,kill_switch_reason=null where id=$1", [principalId]);
  assert.equal((await call(envelope())).status, 200);

  await db.admin.query("update crm_service_principals set state='REVOKED',revoked_at=now() where id=$1", [principalId]);
  assert.equal((await call(envelope())).status, 401);
  await db.admin.query("update crm_service_principals set state='ACTIVE',revoked_at=null where id=$1", [principalId]);
  assert.equal((await call(envelope())).status, 200);
});
