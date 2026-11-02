import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isPinnedRecoveryOperator, recoverySecretNames, sealOperatorRecovery } from "../src/lib/operator-recovery";
import type { AppSession } from "../src/lib/auth/session";
import recipient from "../config/operator-recovery-recipient.json";

const operator = { authenticated: true, source: "cookie", workspaceId: recipient.workspaceId, userId: recipient.operatorUserId,
  authIdentityId: recipient.operatorCentralIdentityId, authSessionId: "synthetic-durable-session", role: "admin", productRole: "novalureAdmin",
  mfaVerifiedAt: "2026-11-02T00:00:00Z" } as AppSession;
test("only the actual pinned operator, central identity and durable MFA session qualify", () => {
  assert.equal(isPinnedRecoveryOperator(operator), true);
  for (const delta of [{ userId: "another-owner" }, { authIdentityId: "another-identity" }, { workspaceId: "another-tenant" },
    { source: "headers" }, { source: "demo" }, { mfaVerifiedAt: null }, { authSessionId: undefined }, { authenticated: false },
    { role: "owner" }, { productRole: "novalure_operator" }]) {
    assert.equal(isPinnedRecoveryOperator({ ...operator, ...delta } as AppSession), false);
  }
});

test("fixed key allowlist is sealed to pinned RSA recipient, extra environment secrets never enter output", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(recoverySecretNames.map(name => [name, randomBytes(48).toString("base64url")])) };
  env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_" + randomBytes(48).toString("base64url");
  env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40); env.RESEND_API_KEY = "excluded_" + randomBytes(48).toString("base64url");
  const sealed = sealOperatorRecovery(env), encoded = JSON.stringify(sealed);
  assert.equal(sealed.recipientSha256, recipient.recipientSha256);
  assert.deepEqual(sealed.secretNames, [...recoverySecretNames]);
  assert.equal(Buffer.from(sealed.wrappedKey, "base64").length, 512);
  assert.equal(Buffer.from(sealed.iv, "base64").length, 12);
  assert.equal(Buffer.from(sealed.tag, "base64").length, 16);
  assert.equal(JSON.parse(Buffer.from(sealed.aad, "base64").toString()).sourceRevision, env.VERCEL_GIT_COMMIT_SHA);
  for (const name of [...recoverySecretNames, "RESEND_API_KEY"]) assert.ok(!encoded.includes(env[name]!));
  assert.notEqual(sealOperatorRecovery(env).ciphertext, sealed.ciphertext);
  for (const name of recoverySecretNames) assert.throws(() => sealOperatorRecovery({ ...env, [name]: "" }), /RECOVERY_CONFIGURATION_UNAVAILABLE/);
});

test("route remains default-off and rejects preview identity headers when enabled", async () => {
  const original = process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT;
  try {
    delete process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT;
    const { POST } = await import("../src/app/api/internal/operator-recovery/route");
    assert.equal((await POST(new Request("https://example.invalid/api/internal/operator-recovery", { method: "POST" }))).status, 404);
    process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT = "1";
    const forged = new Request("https://example.invalid/api/internal/operator-recovery", { method: "POST", headers: {
      "x-novalure-user-id": recipient.operatorUserId, "x-novalure-workspace-id": recipient.workspaceId, "x-novalure-role": "admin",
    } });
    assert.equal((await POST(forged)).status, 401);
  } finally { if (original === undefined) delete process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT; else process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT = original; }
});

test("real PostgreSQL route authorizes durable operator cookie and CSRF, audits only metadata and limits exports", { timeout: 120000 }, async () => {
  const { startLocalSalesDb, applySalesSchema } = await import("./lib/local-sales-db.mjs");
  const { createCsrfToken } = await import("../src/lib/security/csrf-core");
  const { closeLocalTestPool } = await import("../src/lib/db/local-test-transport");
  const { encryptMfaSecret } = await import("../src/lib/auth/mfa");
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT",
    "NOVALURE_OPERATOR_RECOVERY_EXPORT", ...recoverySecretNames, "VERCEL", "VERCEL_ENV", "VERCEL_URL"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await applySalesSchema(db);
    for (const key of keys) delete process.env[key];
    for (const key of recoverySecretNames) process.env[key] = randomBytes(48).toString("base64url");
    process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_" + randomBytes(48).toString("base64url");
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1",
      NOVALURE_APP_ORIGIN: "http://127.0.0.1:3000", NOVALURE_AUTH_STRICT: "1", NOVALURE_OPERATOR_RECOVERY_EXPORT: "1" });
    const email = "synthetic-recovery@example.invalid";
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC RECOVERY','novalure_internal','novalure_internal') on conflict(id) do nothing", [recipient.workspaceId]);
    await db.admin.query(`insert into auth_identities(id,normalized_email,display_email,credential_state,mfa_enabled_at,mfa_secret_ciphertext)
      values($1,$2,$2,'active',now(),$3)`, [recipient.operatorCentralIdentityId, email, encryptMfaSecret("JBSWY3DPEHPK3PXP")]);
    await db.admin.query(`insert into workspace_users(id,workspace_id,auth_identity_id,name,email,role,product_role,status)
      values($1,$2,$3,'SYNTHETIC PINNED RECOVERY',$4,'admin','novalureAdmin','active')
      on conflict(id) do update set auth_identity_id=excluded.auth_identity_id,name=excluded.name,email=excluded.email,role=excluded.role,product_role=excluded.product_role,status=excluded.status`, [recipient.operatorUserId, recipient.workspaceId, recipient.operatorCentralIdentityId, email]);
    const cookie = "v2." + randomBytes(32).toString("base64url"), sessionId = randomUUID();
    await db.admin.query(`insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at)
      values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')`, [sessionId, createHash("sha256").update(cookie).digest("hex"), recipient.operatorCentralIdentityId, recipient.operatorUserId, recipient.workspaceId]);
    const { POST } = await import("../src/app/api/internal/operator-recovery/route");
    const pathname = "/api/internal/operator-recovery", origin = process.env.NOVALURE_APP_ORIGIN;
    const request = (token = true) => new Request(origin + pathname, { method: "POST", headers: {
      cookie: "novalure_session=" + cookie, origin: origin!, "sec-fetch-site": "same-origin",
      ...(token ? { "x-novalure-csrf-token": createCsrfToken({ method: "POST", pathname, secret: process.env.NOVALURE_SESSION_SECRET!, sessionCookie: cookie })!.token } : {}),
    } });
    assert.equal((await POST(request(false))).status, 403);
    assert.equal((await POST(new Request(request(), { body: '{"recipient":"attacker-controlled"}' }))).status, 400);
    await db.admin.query("update auth_sessions set mfa_verified_at=null where id=$1", [sessionId]);
    assert.ok([401, 403].includes((await POST(request())).status));
    await db.admin.query("update auth_sessions set mfa_verified_at=now() where id=$1", [sessionId]);
    for (let i = 0; i < 3; i++) {
      const response = await POST(request()); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const encoded = await response.text();
      for (const key of recoverySecretNames) assert.ok(!encoded.includes(process.env[key]!));
    }
    assert.equal((await POST(request())).status, 429);
    const audit = (await db.admin.query("select after from audit_logs where action='operator.recovery.sealed'")).rows;
    assert.equal(audit.length, 3);
    for (const row of audit) {
      assert.deepEqual(Object.keys(row.after).sort(), ["recipientSha256", "secretNames", "sourceRevision"]);
      assert.equal(row.after.recipientSha256, recipient.recipientSha256);
    }
    await db.admin.query("update workspace_users set status='invited' where id=$1", [recipient.operatorUserId]);
    assert.ok([401, 403].includes((await POST(request())).status));
    assert.equal((await db.admin.query("select count(*)::int as n from audit_logs where action='operator.recovery.sealed'")).rows[0].n, 3);
  } finally {
    await closeLocalTestPool();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await db.stop();
  }
});
