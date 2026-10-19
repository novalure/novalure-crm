import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authenticateIdentityLogin,
  continueIdentityLogin,
  getLoginChallengeView,
  loginChallengeCookieName,
  type AuthenticatedMembership,
  type AuthFlowResult,
} from "../src/lib/auth/auth-flow";
import { decryptMfaSecret, encryptMfaSecret, hashRecoveryCode } from "../src/lib/auth/mfa";
import { hashOpaqueToken, protectLowEntropyValue } from "../src/lib/auth/auth-security";
import { hashPassword, verifyPassword } from "../src/lib/auth/passwords";
import { reserveAuthRateLimitAttempt } from "../src/lib/auth/rate-limit";
import {
  confirmPasswordReset,
  createMembershipPasswordResetLink,
  createPasswordResetFormToken,
  exchangePasswordResetToken,
  passwordResetExchangeCookieName,
} from "../src/lib/auth/password-reset";
import {
  createPersistedSession,
  readPersistedSession,
  rotatePersistedRequestSession,
  sessionCookieName,
  touchPersistedRequestSession,
} from "../src/lib/auth/session-store";
import { getRequestSession } from "../src/lib/auth/session";
import { closeLocalTestPool, getLocalTestPool } from "../src/lib/db/local-test-transport";
import { changeOwnWorkspacePassword } from "../src/lib/db/settings-access-repositories";
import { withTenantTransaction } from "../src/lib/db/tenant-client";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

type Challenge = Extract<AuthFlowResult, { kind: "challenge" }>;
type Authenticated = Extract<AuthFlowResult, { kind: "authenticated" }>;

// Independent RFC 4226/6238 calculation: the tested verifier is never used to
// produce its own expected code. Time changes only inside this test process.
function totp(secret: string, time: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) {
    const digit = alphabet.indexOf(character);
    assert.ok(digit >= 0);
    bits += digit.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function challenge(result: AuthFlowResult, expected: Challenge["challengeKind"]) {
  assert.equal(result.kind, "challenge", JSON.stringify(result));
  if (result.kind !== "challenge") throw new Error("Expected a persisted login challenge");
  assert.equal(result.challengeKind, expected);
  return result;
}

function authenticated(result: AuthFlowResult): Authenticated {
  assert.equal(result.kind, "authenticated", JSON.stringify(result));
  if (result.kind !== "authenticated") throw new Error("Expected authenticated membership");
  assert.ok(result.mfaVerifiedAt instanceof Date);
  return result;
}

function denied(result: AuthFlowResult) {
  assert.equal(result.kind, "error", JSON.stringify(result));
  if (result.kind === "error") assert.notEqual(result.error, "database_unavailable");
}

/** Pause one real query before forwarding it unchanged to the real PG pool. */
async function withQueryBarrier<Result>(match: RegExp, start: () => Promise<Result>, whilePaused: () => Promise<void>) {
  const pool = await getLocalTestPool(process.env.DATABASE_URL!);
  assert.ok(pool);
  const originalQuery = pool.query;
  let release!: () => void;
  let reached!: () => void;
  let consumed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { reached = resolve; });
  pool.query = (async (...args: unknown[]) => {
    if (!consumed && typeof args[0] === "string" && match.test(args[0])) {
      consumed = true;
      reached();
      await gate;
    }
    return Reflect.apply(originalQuery, pool, args);
  }) as typeof pool.query;
  const running = start();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      paused,
      running.then(() => { throw new Error("Auth flow completed before reaching the expected real query barrier"); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Real auth query barrier timed out")), 10_000); }),
    ]);
    await whilePaused();
    release();
    return await running;
  } finally {
    release();
    await running.catch(() => undefined);
    pool.query = originalQuery;
    clearTimeout(timeout);
  }
}

test("MFA boundaries against disposable synthetic PostgreSQL and real auth functions", { timeout: 180_000 }, async t => {
  const environmentKeys = [
    "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "CRM_LOCAL_TEST_DATABASE", "DATABASE_URL",
    "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_SESSION_SECRET",
    "NOVALURE_APP_ORIGIN", "NOVALURE_TRUSTED_CLIENT_IP_HEADER",
  ];
  const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const realNow = Date.now;
  const baseTime = Math.floor(realNow() / 30_000) * 30_000 + 10_000;
  let currentTime = baseTime;
  let fixtureNumber = 0;
  let db: Awaited<ReturnType<typeof startLocalSalesDb>> | undefined;
  const sensitiveValues: string[] = [];
  try {
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) delete process.env[key];
    Object.assign(process.env, {
      NODE_ENV: "test",
      CRM_LOCAL_TEST_DATABASE: "1",
      NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(32).toString("base64url"),
      NOVALURE_SESSION_SECRET: randomBytes(32).toString("base64url"),
      NOVALURE_APP_ORIGIN: "https://mfa.example.invalid",
      NOVALURE_TRUSTED_CLIENT_IP_HEADER: "x-synthetic-client-ip",
    });
    db = await startLocalSalesDb();
    const localDb = db;
    await applySalesSchema(localDb, { includeSales: false, maxMigrationNumber: 79 });
    // Existing credentials and MFA data predate the new columns, exactly as
    // they do on an upgrade. Both current and stale proofs must stay distinct.
    const existing = {
      workspaceId: randomUUID(), userId: randomUUID(),
      password: `SYNTHETIC existing password ${randomUUID()}`,
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      recovery: "AAAA-BBBB-CCCC-DDDD",
      currentSession: `v2.${randomBytes(32).toString("base64url")}`,
      staleSession: `v2.${randomBytes(32).toString("base64url")}`,
      currentChallenge: `v1.${randomBytes(32).toString("base64url")}`,
      staleChallenge: `v1.${randomBytes(32).toString("base64url")}`,
    };
    sensitiveValues.push(existing.password, existing.secret, existing.recovery, existing.currentSession, existing.staleSession, existing.currentChallenge, existing.staleChallenge);
    const existingHash = await hashPassword(existing.password);
    const existingCiphertext = encryptMfaSecret(existing.secret);
    await localDb.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC existing MFA workspace')", [existing.workspaceId]);
    const existingUser = await localDb.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,password_hash) values($1,$2,'SYNTHETIC existing MFA user',$3,'owner','customer_owner','active',$4) returning auth_identity_id", [existing.userId, existing.workspaceId, `${existing.userId}@example.invalid`, existingHash]);
    const existingIdentityId = existingUser.rows[0].auth_identity_id as string;
    await localDb.admin.query("update auth_identities set mfa_secret_ciphertext=$2,mfa_enabled_at=now() where id=$1", [existingIdentityId, existingCiphertext]);
    await localDb.admin.query("insert into auth_mfa_recovery_codes(auth_identity_id,code_hash,used_at) values($1,$2,now())", [existingIdentityId, hashRecoveryCode(existing.recovery)]);
    for (const stale of [false, true]) {
      await localDb.admin.query("insert into auth_sessions(token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,created_at,expires_at) values($1,$2,$3,$4,now(),now()-($5::int*interval '1 hour'),now()+interval '2 hours')", [hashOpaqueToken(stale ? existing.staleSession : existing.currentSession), existingIdentityId, existing.userId, existing.workspaceId, stale ? 2 : 0]);
      await localDb.admin.query("insert into auth_login_challenges(token_hash,kind,auth_identity_id,workspace_user_id,created_at,expires_at) values($1,'mfa_verification',$2,$3,now()-($4::int*interval '1 hour'),now()+interval '10 minutes')", [hashOpaqueToken(stale ? existing.staleChallenge : existing.currentChallenge), existingIdentityId, existing.userId, stale ? 2 : 0]);
    }
    // This additive migration runs unchanged, separately from the sales schema.
    const mfaMigration = await readFile("migrations/106_auth_mfa_hardening.sql", "utf8");
    await localDb.admin.query(mfaMigration);
    await localDb.admin.query(mfaMigration);
    // The historical fixture predates runtime bootstrap grants for these two
    // tables. Grant only what the actual password-reset flow needs locally.
    await localDb.admin.query(`grant update on workspace_users to ${localDb.role}`);
    await localDb.admin.query(`grant select, insert, update on auth_password_reset_tokens to ${localDb.role}`);
    process.env.DATABASE_URL = `postgresql://${localDb.role}@127.0.0.1:${localDb.port}/postgres`;
    Date.now = () => currentTime;

    async function fixture(input: { role?: "owner" | "admin" | "agent" | "assistant"; productRole?: "customer_owner" | "viewer" } = {}) {
      currentTime = baseTime;
      fixtureNumber += 1;
      const workspaceId = randomUUID();
      const workspaceUserId = randomUUID();
      const email = `synthetic-mfa-${randomUUID()}@example.invalid`;
      const password = `SYNTHETIC password ${randomUUID()}`;
      sensitiveValues.push(password);
      const passwordHash = await hashPassword(password);
      const role = input.role ?? "owner";
      const productRole = input.productRole ?? "customer_owner";
      const ip = `198.51.100.${fixtureNumber}`;
      await localDb.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC MFA QA','self_service_customer','real_estate_broker')", [workspaceId]);
      const created = await localDb.admin.query(
        "insert into workspace_users(id,workspace_id,name,email,role,product_role,password_hash,status) values($1,$2,'SYNTHETIC MFA user',$3,$4,$5,$6,'active') returning auth_identity_id",
        [workspaceUserId, workspaceId, email, role, productRole, passwordHash],
      );
      const authIdentityId = created.rows[0].auth_identity_id as string;
      const passwordVersion = (await localDb.admin.query("select password_changed_at::text as version from auth_identities where id=$1", [authIdentityId])).rows[0].version as string | null;
      const request = (cookie?: string, clientIp = ip) => new Request("https://mfa.example.invalid/api/auth/login/continue", {
        method: "POST",
        headers: {
          origin: "https://mfa.example.invalid",
          "sec-fetch-site": "same-origin",
          "user-agent": "SYNTHETIC MFA integration",
          "x-synthetic-client-ip": clientIp,
          ...(cookie ? { cookie } : {}),
        },
      });
      const challengeRequest = (value: Challenge, clientIp = ip) => request(`${loginChallengeCookieName}=${value.challengeCookie}`, clientIp);
      const login = (nextPassword = password, clientIp = ip) => authenticateIdentityLogin({ email, password: nextPassword, request: request(undefined, clientIp) });
      const verify = (value: Challenge, code: string, recoveryCodesSaved = false, clientIp = ip) => continueIdentityLogin({
        code, recoveryCodesSaved, request: challengeRequest(value, clientIp),
      });
      const view = (value: Challenge) => getLoginChallengeView(challengeRequest(value).headers);
      const membership: AuthenticatedMembership = {
        authIdentityId, email, id: workspaceUserId, mfaEnabledAt: null, passwordVersion,
        name: "SYNTHETIC MFA user", productRole, role, workspaceId, workspaceName: "SYNTHETIC MFA QA",
      };
      async function enrollment() {
        const pending = challenge(await login(), "mfa_enrollment");
        const setup = await view(pending);
        assert.equal(setup?.kind, "mfa_enrollment");
        if (!setup || setup.kind !== "mfa_enrollment") throw new Error("Expected enrollment view");
        sensitiveValues.push(setup.secret, pending.challengeCookie, ...setup.recoveryCodes);
        return { pending, setup };
      }
      async function enroll() {
        const state = await enrollment();
        const result = authenticated(await verify(state.pending, totp(state.setup.secret, currentTime), true));
        return { ...state, result };
      }
      const sessionCookie = (value: string) => `${sessionCookieName}=${value}`;
      async function sessionCount() {
        return (await localDb.admin.query("select count(*)::int as count from auth_sessions where auth_identity_id=$1", [authIdentityId])).rows[0].count as number;
      }
      async function resetPassword() {
        const link = await createMembershipPasswordResetLink({ language: "de", workspaceId, workspaceUserId });
        const resetToken = new URLSearchParams(new URL(link.resetUrl).hash.slice(1)).get("token");
        assert.ok(resetToken);
        sensitiveValues.push(resetToken);
        const exchange = await exchangePasswordResetToken(resetToken, request());
        assert.ok(exchange);
        sensitiveValues.push(exchange.cookieValue);
        const resetRequest = request(`${passwordResetExchangeCookieName}=${exchange.cookieValue}`);
        const formToken = createPasswordResetFormToken(resetRequest.headers);
        assert.ok(formToken);
        const nextPassword = `SYNTHETIC replacement ${randomUUID()}`;
        sensitiveValues.push(nextPassword);
        assert.deepEqual(await confirmPasswordReset({ confirmation: nextPassword, formToken, password: nextPassword, request: resetRequest }), { status: "ok" });
        return nextPassword;
      }
      return { authIdentityId, workspaceId, workspaceUserId, membership, email, password, passwordHash, request, challengeRequest, login, verify, view, enrollment, enroll, sessionCookie, sessionCount, resetPassword };
    }

    await t.test("additive migration preserves existing credentials, factor, recovery usage and roles while backfilling only current proofs", async () => {
      const identity = (await localDb.admin.query("select password_hash,mfa_secret_ciphertext,mfa_enabled_at from auth_identities where id=$1", [existingIdentityId])).rows[0];
      assert.equal(identity.password_hash, existingHash);
      assert.equal(identity.mfa_secret_ciphertext, existingCiphertext);
      assert.ok(identity.mfa_enabled_at);
      const recovery = (await localDb.admin.query("select code_hash,used_at from auth_mfa_recovery_codes where auth_identity_id=$1", [existingIdentityId])).rows[0];
      assert.equal(recovery.code_hash, hashRecoveryCode(existing.recovery));
      assert.ok(recovery.used_at);
      const valid = await readPersistedSession(`${sessionCookieName}=${existing.currentSession}`);
      assert.equal(valid?.id, existing.userId);
      assert.equal(valid?.role, "owner");
      assert.equal(valid?.productRole, "customer_owner");
      assert.equal(await readPersistedSession(`${sessionCookieName}=${existing.staleSession}`), null);
      const view = (token: string) => getLoginChallengeView(new Headers({ cookie: `${loginChallengeCookieName}=${token}` }));
      assert.equal((await view(existing.currentChallenge))?.kind, "mfa_verification");
      assert.equal(await view(existing.staleChallenge), null);
    });

    await t.test("runtime is a loopback non-superuser role; a wrong password never creates a challenge or session", async () => {
      const role = await localDb.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user");
      assert.equal(role.rows[0].rolsuper, false);
      assert.equal(role.rows[0].rolbypassrls, false);
      const f = await fixture();
      denied(await f.login("incorrect synthetic password"));
      assert.equal(await f.sessionCount(), 0);
      assert.equal((await localDb.admin.query("select count(*)::int as count from auth_login_challenges where auth_identity_id=$1", [f.authIdentityId])).rows[0].count, 0);
    });

    await t.test("existing valid password requires enrollment, explicit recovery confirmation and verified code before session creation", async () => {
      const f = await fixture();
      const { pending, setup } = await f.enrollment();
      assert.match(setup.secret, /^[A-Z2-7]{32}$/);
      const provisioning = new URL(setup.provisioningUri);
      assert.equal(provisioning.protocol, "otpauth:");
      assert.equal(provisioning.searchParams.get("secret"), setup.secret);
      assert.equal(provisioning.searchParams.get("issuer"), "Novalure CRM");
      assert.equal(setup.recoveryCodes.length, 10);
      assert.equal(new Set(setup.recoveryCodes).size, 10);
      assert.equal(await f.sessionCount(), 0);
      await assert.rejects(createPersistedSession({ membership: f.membership, mfaVerifiedAt: null, request: f.request() }), /MFA|failed closed/);
      // A stale/forged ordinary membership must also fail against the real DB role.
      await assert.rejects(createPersistedSession({ membership: { ...f.membership, role: "assistant", productRole: "viewer" }, mfaVerifiedAt: null, request: f.request() }), /MFA|failed closed/);
      denied(await f.verify(pending, "invalid-code", true));
      denied(await f.verify(pending, totp(setup.secret, currentTime)));
      assert.equal((await localDb.admin.query("select mfa_enabled_at from auth_identities where id=$1", [f.authIdentityId])).rows[0].mfa_enabled_at, null);
      const result = authenticated(await f.verify(pending, totp(setup.secret, currentTime), true));
      assert.equal(await f.view(pending), null);
      denied(await f.verify(pending, totp(setup.secret, currentTime), true));
      assert.equal(await f.sessionCount(), 0, "auth flow itself never mints a session");
      const stored = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(stored.value);
      const read = await readPersistedSession(f.sessionCookie(stored.value));
      assert.equal(read?.authIdentityId, f.authIdentityId);
      assert.equal(read?.id, f.workspaceUserId);
      assert.equal(read?.role, "owner");
      assert.equal(read?.productRole, "customer_owner");
      assert.ok(read?.mfaVerifiedAt);
      const password = (await localDb.admin.query("select password_hash from auth_identities where id=$1", [f.authIdentityId])).rows[0].password_hash;
      assert.equal(password, f.passwordHash, "enrollment preserves the existing password hash");
      assert.equal(await verifyPassword(f.password, password), true);
      const rotated = await rotatePersistedRequestSession({ cookieHeader: f.sessionCookie(stored.value), request: f.request() });
      assert.ok(rotated);
      sensitiveValues.push(rotated.value);
      assert.equal(await readPersistedSession(f.sessionCookie(stored.value)), null);
      const next = await readPersistedSession(f.sessionCookie(rotated.value));
      assert.equal(next?.role, "owner");
      assert.equal(next?.productRole, "customer_owner");
      assert.equal(new Date(next!.mfaVerifiedAt!).valueOf(), new Date(read!.mfaVerifiedAt!).valueOf());
      assert.equal(new Date(next!.expiresAt).valueOf(), new Date(read!.expiresAt).valueOf());
    });

    await t.test("a challenge stops at its own attempt budget and expired or missing challenges fail closed", async () => {
      const f = await fixture();
      const { pending, setup } = await f.enrollment();
      await localDb.admin.query("update auth_login_challenges set max_attempts=3 where token_hash=$1", [hashOpaqueToken(pending.challengeCookie)]);
      for (let attempt = 0; attempt < 3; attempt += 1) denied(await f.verify(pending, "invalid-code", true));
      denied(await f.verify(pending, totp(setup.secret, currentTime), true));
      assert.equal(await f.view(pending), null);
      const row = (await localDb.admin.query("select attempts,used_at,payload_ciphertext from auth_login_challenges where token_hash=$1", [hashOpaqueToken(pending.challengeCookie)])).rows[0];
      assert.equal(row.attempts, 3);
      assert.ok(row.used_at);
      assert.equal(row.payload_ciphertext, null);
      const expired = challenge(await f.login(), "mfa_enrollment");
      await localDb.admin.query("update auth_login_challenges set created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute' where token_hash=$1", [hashOpaqueToken(expired.challengeCookie)]);
      assert.equal(await f.view(expired), null);
      denied(await f.verify(expired, "123456", true));
      denied(await continueIdentityLogin({ code: "123456", request: f.request() }));
      assert.equal(await f.sessionCount(), 0);
    });

    await t.test("MFA identity throttling survives fresh password logins, fresh challenges and changed IP addresses", async () => {
      const f = await fixture();
      const { setup } = await f.enroll();
      currentTime = baseTime + 30_000;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const clientIp = `203.0.113.${attempt + 1}`;
        const pending = challenge(await f.login(f.password, clientIp), "mfa_verification");
        denied(await f.verify(pending, "invalid-code", false, clientIp));
      }
      const pending = challenge(await f.login(f.password, "203.0.113.90"), "mfa_verification");
      denied(await f.verify(pending, totp(setup.secret, currentTime), false, "203.0.113.91"));
      const bucket = (await localDb.admin.query("select attempt_count,blocked_until>now() as blocked from auth_rate_limit_buckets where scope='mfa_email' and subject_hash=$1", [protectLowEntropyValue("mfa-email", f.email)])).rows[0];
      assert.ok(bucket.attempt_count >= 5);
      assert.equal(bucket.blocked, true);
      assert.equal(await f.sessionCount(), 0);
      // Advance persisted backoff only; no live wait or fake database clock.
      await localDb.admin.query("update auth_rate_limit_buckets set blocked_until=now()-interval '1 second' where scope='mfa_email' and subject_hash=$1", [protectLowEntropyValue("mfa-email", f.email)]);
      authenticated(await f.verify(pending, totp(setup.secret, currentTime), false, "203.0.113.92"));
      assert.equal((await localDb.admin.query("select count(*)::int as count from auth_rate_limit_buckets where scope='mfa_email' and subject_hash=$1", [protectLowEntropyValue("mfa-email", f.email)])).rows[0].count, 0, "successful MFA clears its persisted backoff");
    });

    await t.test("durable MFA limiter serializes concurrent attempts, preserves denied deadlines and admits progressive retries", async () => {
      const email = `synthetic-limiter-${randomUUID()}@example.invalid`;
      const ip = "203.0.113.200";
      const request = new Request("https://mfa.example.invalid/api/auth/login/continue", { headers: { "x-synthetic-client-ip": ip } });
      const emailHash = protectLowEntropyValue("mfa-email", email);
      const ipHash = protectLowEntropyValue("mfa-ip", ip);
      const reserve = (nextEmail = email) => reserveAuthRateLimitAttempt({ email: nextEmail, kind: "mfa", request });
      const rows = () => localDb.admin.query("select * from auth_rate_limit_buckets where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2)) order by scope", [emailHash, ipHash]);
      const parallel = await Promise.all(Array.from({ length: 20 }, () => reserve()));
      assert.equal(parallel.filter(result => !result.blocked).length, 5);
      assert.ok(parallel.every(result => result.attempts.length === 2 && result.attempts.every(row => row.attemptCount <= 5)));
      const before = (await rows()).rows;
      assert.equal((await reserve()).blocked, true);
      assert.equal((await reserve()).blocked, true);
      assert.deepEqual((await rows()).rows, before, "blocked requests cannot extend deadlines or inflate counters");
      await localDb.admin.query("update auth_rate_limit_buckets set blocked_until=clock_timestamp()-interval '1 millisecond' where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2))", [emailHash, ipHash]);
      const retry = await reserve();
      assert.equal(retry.blocked, false);
      assert.ok(retry.attempts.every(row => row.attemptCount === 6));
      const backoff = await localDb.admin.query("select extract(epoch from (blocked_until-last_attempt_at)) as seconds from auth_rate_limit_buckets where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2))", [emailHash, ipHash]);
      assert.ok(backoff.rows.every((row: { seconds: string }) => Number(row.seconds) === 2));
      const sharedIp = await reserve(`synthetic-other-${randomUUID()}@example.invalid`);
      assert.equal(sharedIp.blocked, true);
      assert.equal(sharedIp.attempts.find(row => row.scope === "mfa_email")?.attemptCount, 0, "an IP block does not spend a fresh identity's budget");
      await localDb.admin.query("update auth_rate_limit_buckets set window_started_at=clock_timestamp()-interval '3601 seconds',blocked_until=clock_timestamp()+interval '1 hour' where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2))", [emailHash, ipHash]);
      const newWindow = await reserve();
      assert.equal(newWindow.blocked, false);
      assert.ok(newWindow.attempts.every(row => row.attemptCount === 1));
      await localDb.admin.query("update auth_rate_limit_buckets set attempt_count=30,blocked_until=clock_timestamp()-interval '1 second' where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2))", [emailHash, ipHash]);
      const capped = await reserve();
      assert.equal(capped.blocked, false);
      const cap = await localDb.admin.query("select extract(epoch from (blocked_until-last_attempt_at)) as seconds from auth_rate_limit_buckets where (scope,subject_hash) in (('mfa_email',$1),('mfa_ip',$2))", [emailHash, ipHash]);
      assert.ok(cap.rows.every((row: { seconds: string }) => Number(row.seconds) === 3600));
      const metadata = (await localDb.admin.query("select prosecdef,proconfig,has_function_privilege($1,oid,'EXECUTE') as app_exec from pg_proc where oid='public.reserve_mfa_rate_limit_attempt(text,text)'::regprocedure", [localDb.role])).rows[0];
      assert.equal(metadata.prosecdef, false);
      assert.ok(metadata.proconfig.includes("search_path=pg_catalog, public, pg_temp"));
      assert.equal(metadata.app_exec, true);
    });

    await t.test("an enrollment TOTP cannot be replayed across fresh challenges; a later counter succeeds exactly once under concurrency", async () => {
      const f = await fixture();
      const { setup } = await f.enroll();
      const replay = challenge(await f.login(), "mfa_verification");
      denied(await f.verify(replay, totp(setup.secret, baseTime)));
      currentTime = baseTime + 30_000;
      const first = challenge(await f.login(), "mfa_verification");
      const second = challenge(await f.login(), "mfa_verification");
      const results = await Promise.all([f.verify(first, totp(setup.secret, currentTime)), f.verify(second, totp(setup.secret, currentTime))]);
      assert.equal(results.filter(result => result.kind === "authenticated").length, 1);
      results.filter(result => result.kind !== "authenticated").forEach(denied);
      const persisted = (await localDb.admin.query("select mfa_last_totp_counter from auth_identities where id=$1", [f.authIdentityId])).rows[0];
      assert.equal(Number(persisted.mfa_last_totp_counter), Math.floor(currentTime / 30_000));
      const third = challenge(await f.login(), "mfa_verification");
      denied(await f.verify(third, totp(setup.secret, currentTime)));
      assert.equal(await f.sessionCount(), 0);
    });

    await t.test("recovery codes are single-use across challenges and simultaneous submissions", async () => {
      const f = await fixture();
      const { setup } = await f.enroll();
      const first = challenge(await f.login(), "mfa_verification");
      authenticated(await f.verify(first, setup.recoveryCodes[0]));
      denied(await f.verify(first, setup.recoveryCodes[0]));
      const replay = challenge(await f.login(), "mfa_verification");
      denied(await f.verify(replay, setup.recoveryCodes[0]));
      const second = challenge(await f.login(), "mfa_verification");
      const third = challenge(await f.login(), "mfa_verification");
      const results = await Promise.all([f.verify(second, setup.recoveryCodes[1]), f.verify(third, setup.recoveryCodes[1])]);
      assert.equal(results.filter(result => result.kind === "authenticated").length, 1);
      results.filter(result => result.kind !== "authenticated").forEach(denied);
      const consumed = await localDb.admin.query("select count(*)::int as count from auth_mfa_recovery_codes where auth_identity_id=$1 and used_at is not null", [f.authIdentityId]);
      assert.equal(consumed.rows[0].count, 2);
    });

    await t.test("an enrolled identity still requires MFA when its current membership becomes an ordinary viewer", async () => {
      const f = await fixture();
      const { setup } = await f.enroll();
      await localDb.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [f.workspaceUserId]);
      const pending = challenge(await f.login(), "mfa_verification");
      assert.equal((await f.view(pending))?.kind, "mfa_verification");
      await assert.rejects(createPersistedSession({ membership: { ...f.membership, role: "assistant", productRole: "viewer" }, mfaVerifiedAt: null, request: f.request() }), /MFA|failed closed/);
      currentTime = baseTime + 30_000;
      const result = authenticated(await f.verify(pending, totp(setup.secret, currentTime)));
      assert.equal(result.membership.role, "assistant");
      assert.equal(result.membership.productRole, "viewer");
      const stored = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(stored.value);
      assert.equal((await readPersistedSession(f.sessionCookie(stored.value)))?.productRole, "viewer");
    });

    await t.test("workspace selection cannot bypass identity MFA by choosing an ordinary membership", async () => {
      const f = await fixture();
      const { setup } = await f.enroll();
      const otherWorkspace = randomUUID(), otherUser = randomUUID();
      await localDb.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC other workspace')", [otherWorkspace]);
      await localDb.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC viewer',$3,'assistant','viewer','active')", [otherUser, otherWorkspace, f.email]);
      const selection = challenge(await f.login(), "workspace_selection");
      const selectionView = await f.view(selection);
      assert.equal(selectionView?.kind, "workspace_selection");
      if (selectionView?.kind === "workspace_selection") assert.equal(selectionView.workspaces.length, 2);
      const pending = challenge(await continueIdentityLogin({ request: f.challengeRequest(selection), workspaceUserId: otherUser }), "mfa_verification");
      currentTime = baseTime + 30_000;
      const result = authenticated(await f.verify(pending, totp(setup.secret, currentTime)));
      assert.equal(result.membership.id, otherUser);
      assert.equal(result.membership.workspaceId, otherWorkspace);
      assert.equal(result.membership.role, "assistant");
      assert.equal(result.membership.productRole, "viewer");
    });

    await t.test("legacy password-only privileged sessions cannot be read, touched or rotated; enrollment revokes them", async () => {
      const f = await fixture();
      const token = `v2.${randomBytes(32).toString("base64url")}`;
      const legacyId = randomUUID();
      sensitiveValues.push(token);
      const legacy = await localDb.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,password_version,expires_at) select $1,$2,identity.id,$4,$5,identity.password_changed_at,now()+interval '2 hours' from auth_identities identity where identity.id=$3 returning password_version::text", [legacyId, hashOpaqueToken(token), f.authIdentityId, f.workspaceUserId, f.workspaceId]);
      assert.equal(legacy.rows[0].password_version, f.membership.passwordVersion, "the password proof is current, so MFA assurance is the rejecting guard");
      assert.equal(await readPersistedSession(f.sessionCookie(token)), null);
      assert.equal(await touchPersistedRequestSession(f.sessionCookie(token)), false);
      assert.equal(await rotatePersistedRequestSession({ cookieHeader: f.sessionCookie(token), request: f.request() }), null);
      await f.enroll();
      const revoked = (await localDb.admin.query("select revoked_at from auth_sessions where id=$1", [legacyId])).rows[0];
      assert.ok(revoked.revoked_at);
    });

    await t.test("an enrolled ordinary identity's unverified session with a current password proof cannot be read, touched or rotated", async () => {
      const f = await fixture();
      await f.enroll();
      await localDb.admin.query("update workspace_users set role='assistant',product_role='viewer' where id=$1", [f.workspaceUserId]);
      const token = `v2.${randomBytes(32).toString("base64url")}`;
      const sessionId = randomUUID();
      sensitiveValues.push(token);
      const seeded = await localDb.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,password_version,expires_at) select $1,$2,identity.id,$4,$5,identity.password_changed_at,now()+interval '2 hours' from auth_identities identity where identity.id=$3 returning password_version::text,mfa_verified_at,revoked_at", [sessionId, hashOpaqueToken(token), f.authIdentityId, f.workspaceUserId, f.workspaceId]);
      assert.equal(seeded.rows[0].password_version, f.membership.passwordVersion);
      assert.equal(seeded.rows[0].mfa_verified_at, null);
      assert.equal(seeded.rows[0].revoked_at, null);
      assert.equal(await readPersistedSession(f.sessionCookie(token)), null);
      assert.equal(await touchPersistedRequestSession(f.sessionCookie(token)), false);
      assert.equal(await rotatePersistedRequestSession({ cookieHeader: f.sessionCookie(token), request: f.request() }), null);
      const sessions = await localDb.admin.query("select count(*)::int as count from auth_sessions where auth_identity_id=$1", [f.authIdentityId]);
      assert.equal(sessions.rows[0].count, 1, "a denied rotation must not mint a replacement session");
    });

    await t.test("ordinary unenrolled memberships retain password login and their exact roles", async () => {
      const f = await fixture({ role: "assistant", productRole: "viewer" });
      const result = await f.login();
      assert.equal(result.kind, "authenticated");
      if (result.kind !== "authenticated") throw new Error("Expected ordinary membership login");
      assert.equal(result.mfaVerifiedAt, null);
      const stored = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(stored.value);
      const read = await readPersistedSession(f.sessionCookie(stored.value));
      assert.equal(read?.role, "assistant");
      assert.equal(read?.productRole, "viewer");
    });

    await t.test("a password reset between password verification and challenge insertion prevents delayed stale-password login", async () => {
      const f = await fixture();
      const result = await withQueryBarrier(
        /insert into auth_login_challenges/i,
        () => f.login(),
        async () => { await f.resetPassword(); },
      );
      assert.equal(result.kind, "error", "a stale password proof must not produce a usable MFA enrollment");
      assert.equal((await localDb.admin.query("select count(*)::int as count from auth_login_challenges where auth_identity_id=$1 and used_at is null", [f.authIdentityId])).rows[0].count, 0);
      assert.equal(await f.sessionCount(), 0);
    });

    await t.test("a reset between workspace proof consumption and the next MFA challenge prevents delayed continuation", async () => {
      const f = await fixture();
      const workspaceId = randomUUID(), workspaceUserId = randomUUID();
      await localDb.admin.query("insert into workspaces(id,name) values($1,'SYNTHETIC reset race workspace')", [workspaceId]);
      await localDb.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner','customer_owner','active')", [workspaceUserId, workspaceId, f.email]);
      const selection = challenge(await f.login(), "workspace_selection");
      const result = await withQueryBarrier(
        /insert into auth_login_challenges/i,
        () => continueIdentityLogin({ request: f.challengeRequest(selection), workspaceUserId }),
        async () => { await f.resetPassword(); },
      );
      assert.equal(result.kind, "error", "consuming a workspace choice cannot refresh an old credential proof");
      assert.equal((await localDb.admin.query("select count(*)::int as count from auth_login_challenges where auth_identity_id=$1 and used_at is null", [f.authIdentityId])).rows[0].count, 0);
      assert.equal(await f.sessionCount(), 0);
    });

    await t.test("a reset after MFA verification prevents delayed session insertion with the old credential proof", async () => {
      const f = await fixture();
      const { result } = await f.enroll();
      const outcome = await withQueryBarrier(
        /insert into auth_sessions/i,
        () => createPersistedSession({ ...result, request: f.request() }).then(value => ({ value }), error => ({ error: error as unknown })),
        async () => { await f.resetPassword(); },
      );
      assert.ok("error" in outcome, "reset must invalidate an MFA result before its delayed session write");
      assert.equal(await f.sessionCount(), 0);
    });

    await t.test("own password change preserves the current verified session through rotation and revokes other sessions and challenges", async () => {
      const f = await fixture();
      const { result } = await f.enroll();
      const current = await createPersistedSession({ ...result, request: f.request() });
      const other = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(current.value, other.value);
      const pending = challenge(await f.login(), "mfa_verification");
      const request = f.request(f.sessionCookie(current.value));
      const session = await getRequestSession(request);
      assert.ok(session?.authSessionId);
      const password = `SYNTHETIC own-password change ${randomUUID()}`;
      sensitiveValues.push(password);
      const scope = { actorId: f.workspaceUserId, workspaceId: f.workspaceId };
      // Use the actual tenant context for its existing append-only audit log;
      // all authentication writes still run with the same unprivileged role.
      const changed = await withTenantTransaction(scope, transaction => runWithTenantTransaction(scope, transaction, () => changeOwnWorkspacePassword({
        session, currentPassword: f.password, password, confirmation: password,
      })));
      assert.equal(changed.ok, true);
      assert.equal(await f.view(pending), null);
      assert.equal(await readPersistedSession(f.sessionCookie(other.value)), null);
      const refreshed = await readPersistedSession(f.sessionCookie(current.value));
      assert.ok(refreshed);
      assert.notEqual(refreshed.passwordVersion, result.membership.passwordVersion);
      assert.equal(new Date(refreshed.mfaVerifiedAt!).valueOf(), result.mfaVerifiedAt!.valueOf());
      const rotated = await rotatePersistedRequestSession({ cookieHeader: f.sessionCookie(current.value), request });
      assert.ok(rotated);
      sensitiveValues.push(rotated.value);
      const next = await readPersistedSession(f.sessionCookie(rotated.value));
      assert.equal(next?.passwordVersion, refreshed.passwordVersion);
      assert.equal(next?.role, "owner");
      assert.equal(next?.productRole, "customer_owner");
      assert.equal(await readPersistedSession(f.sessionCookie(current.value)), null);
      denied(await f.login());
      challenge(await f.login(password), "mfa_verification");
    });

    await t.test("a delayed own-password change cannot overwrite a reset after its old password was verified", async () => {
      const f = await fixture();
      const { result } = await f.enroll();
      const current = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(current.value);
      const session = await getRequestSession(f.request(f.sessionCookie(current.value)));
      assert.ok(session);
      const stalePassword = `SYNTHETIC stale replacement ${randomUUID()}`;
      sensitiveValues.push(stalePassword);
      let resetPassword = "";
      const changed = await withQueryBarrier(
        /with credential_updated as/i,
        () => changeOwnWorkspacePassword({ session, currentPassword: f.password, password: stalePassword, confirmation: stalePassword }),
        async () => { resetPassword = await f.resetPassword(); },
      );
      assert.equal(changed.ok, false);
      const hash = (await localDb.admin.query("select password_hash from auth_identities where id=$1", [f.authIdentityId])).rows[0].password_hash as string;
      assert.equal(await verifyPassword(resetPassword, hash), true);
      assert.equal(await verifyPassword(stalePassword, hash), false);
      assert.equal(await readPersistedSession(f.sessionCookie(current.value)), null);
    });

    await t.test("real password reset invalidates pending challenges and sessions while preserving MFA and consumed recovery state", async () => {
      const f = await fixture();
      const { setup, result } = await f.enroll();
      const session = await createPersistedSession({ ...result, request: f.request() });
      sensitiveValues.push(session.value);
      const recovery = challenge(await f.login(), "mfa_verification");
      authenticated(await f.verify(recovery, setup.recoveryCodes[0]));
      const pending = challenge(await f.login(), "mfa_verification");
      const otherPending = challenge(await f.login(), "mfa_verification");
      const before = (await localDb.admin.query("select mfa_enabled_at,mfa_secret_ciphertext,mfa_last_totp_counter from auth_identities where id=$1", [f.authIdentityId])).rows[0];
      const password = await f.resetPassword();
      assert.equal(await f.view(pending), null);
      assert.equal(await f.view(otherPending), null);
      denied(await f.verify(pending, setup.recoveryCodes[1]));
      assert.equal(await readPersistedSession(f.sessionCookie(session.value)), null);
      const after = (await localDb.admin.query("select mfa_enabled_at,mfa_secret_ciphertext,mfa_last_totp_counter from auth_identities where id=$1", [f.authIdentityId])).rows[0];
      assert.deepEqual(after, before, "password reset never resets the second factor or replay counter");
      assert.equal((await localDb.admin.query("select count(*)::int as count from auth_mfa_recovery_codes where auth_identity_id=$1 and used_at is not null", [f.authIdentityId])).rows[0].count, 1);
      denied(await f.login());
      const next = challenge(await f.login(password), "mfa_verification");
      currentTime = baseTime + 30_000;
      authenticated(await f.verify(next, totp(setup.secret, currentTime)));
    });

    await t.test("enrollment payload and factor are encrypted, recovery/token values are hashed, audit is secret-free and append-only", async () => {
      const f = await fixture();
      const { pending, setup } = await f.enrollment();
      const initial = (await localDb.admin.query("select token_hash,payload_ciphertext from auth_login_challenges where token_hash=$1", [hashOpaqueToken(pending.challengeCookie)])).rows[0];
      assert.match(initial.token_hash, /^[a-f0-9]{64}$/);
      assert.match(initial.payload_ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      assert.equal(initial.payload_ciphertext.includes(setup.secret), false);
      assert.equal(initial.payload_ciphertext.includes(setup.recoveryCodes[0]), false);
      authenticated(await f.verify(pending, totp(setup.secret, currentTime), true));
      const identity = (await localDb.admin.query("select mfa_secret_ciphertext from auth_identities where id=$1", [f.authIdentityId])).rows[0];
      assert.notEqual(identity.mfa_secret_ciphertext, setup.secret);
      assert.equal(decryptMfaSecret(identity.mfa_secret_ciphertext), setup.secret);
      const hashes = (await localDb.admin.query("select code_hash from auth_mfa_recovery_codes where auth_identity_id=$1", [f.authIdentityId])).rows.map((row: { code_hash: string }) => row.code_hash);
      assert.deepEqual(new Set(hashes), new Set(setup.recoveryCodes.map(hashRecoveryCode)));
      assert.ok(hashes.every((value: string) => /^[a-f0-9]{64}$/.test(value)));
      const consumed = (await localDb.admin.query("select payload_ciphertext from auth_login_challenges where token_hash=$1", [initial.token_hash])).rows[0];
      assert.equal(consumed.payload_ciphertext, null);
      const auditRows = (await localDb.admin.query("select * from auth_audit_events")).rows;
      const audit = JSON.stringify(auditRows);
      const database = JSON.stringify((await localDb.admin.query(`
        select jsonb_build_object(
          'identities',(select jsonb_agg(to_jsonb(t)) from auth_identities t),
          'challenges',(select jsonb_agg(to_jsonb(t)) from auth_login_challenges t),
          'recovery',(select jsonb_agg(to_jsonb(t)) from auth_mfa_recovery_codes t),
          'sessions',(select jsonb_agg(to_jsonb(t)) from auth_sessions t)
        ) as stored
      `)).rows);
      for (const sensitive of sensitiveValues) {
        assert.equal(audit.includes(sensitive), false, "authentication audit must not contain raw credentials or tokens");
        assert.equal(database.includes(sensitive), false, "authentication tables must not contain raw credentials or tokens");
      }
      assert.ok(auditRows.some((row: { event_type: string }) => row.event_type === "auth.mfa.enrolled"));
      assert.ok(auditRows.some((row: { event_type: string }) => row.event_type === "auth.mfa.verification_failed"));
      assert.ok(auditRows.some((row: { outcome: string }) => row.outcome === "blocked"));
      await assert.rejects(localDb.admin.query("update auth_audit_events set metadata='{}' where id=$1", [auditRows[0].id]), /append-only/);
      await assert.rejects(localDb.admin.query("delete from auth_audit_events where id=$1", [auditRows[0].id]), /append-only/);
    });
  } finally {
    Date.now = realNow;
    await closeLocalTestPool();
    if (db) await db.stop();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
