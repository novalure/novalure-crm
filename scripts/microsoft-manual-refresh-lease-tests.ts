import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { protectMailboxToken, syncCrmMailbox, unprotectMailboxToken } from "../src/lib/db/crm-mailbox-repository";
import type { MailboxTransport } from "../src/lib/integrations/mailbox-provider";

// Synthetic scripted transport and pool only: no actual PostgreSQL, RLS, or Graph.
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-manual-refresh-test-key";
process.env.MICROSOFT_MAILBOX_IDENTITY_MODE = "verified-preview";
process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = "0";
process.env.VERCEL = "1";
process.env.VERCEL_ENV = "preview";
process.env.MICROSOFT_CLIENT_ID = "synthetic-calendar";
process.env.MICROSOFT_MAILBOX_CLIENT_ID = "synthetic-client";
process.env.MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD = "client-secret";
process.env.MICROSOFT_MAILBOX_CLIENT_SECRET = "synthetic-secret";
const ws = randomUUID(), user = randomUUID(), id = randomUUID(), tenant = randomUUID(), account = randomUUID();
const label = "synthetic@example.invalid", subject = "synthetic-subject";
const session = { authenticated: true, workspaceId: ws, userId: user, workspaceName: "Synthetic", email: "synthetic@example.invalid", name: "Synthetic", source: "database", role: "owner", productRole: "customer_owner", permissions: ["crm:read"], productPermissions: [] } as AppSession;
const verify = async () => ({ tenantId: tenant, objectId: account, subject });
const auth = async () => ({ client_id: "synthetic-client", client_secret: "synthetic-secret" });

function fixture(mode: "normal" | "success" | "final-wait-expired" | "google-success" | "google-final-expired" | "legacy-success" | "legacy-final-expired" | "no-rotation" | "empty-refresh" | "lease-replaced" | "lease-expired" | "lock-wait-expired" | "identity-changed" | "account-changed" | "member-revoked" | "verification-fails" | "claim-denied" | "busy-after-lock" | "preflight-expired" | "preflight-replaced" | "preflight-revision" | "preflight-identity") {
  const provider = mode.startsWith("google-") ? "google" : "microsoft";
  const legacy = provider === "google" || mode.startsWith("legacy-");
  let lease: string | null = null, leaseExpired = false, memberActive = true, revision = 7, access = protectMailboxToken(session, provider, "OLD_ACCESS", label), refresh = protectMailboxToken(session, provider, "OLD_REFRESH", label), writes = 0, pages = 0, providerCalls = 0, claimCommitted = false;
  let currentSubject = subject, status = "connected", lastError: string | null = null;
  const pool = { async connect() { return { release() {}, async query(sql: string, args: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("from pg_roles runtime_role")) return { rows: [{ safe: true }] };
    if (normalized === "begin" || normalized === "rollback" || normalized === "commit") { if (normalized === "commit" && lease && !claimCommitted) { claimCommitted = true; if (mode === "preflight-expired") leaseExpired = true; if (mode === "preflight-replaced") lease = randomUUID(); if (mode === "preflight-revision") revision++; if (mode === "preflight-identity") currentSubject = "other-subject"; } return { rows: [], command: normalized.toUpperCase() }; }
    if (normalized.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId: ws, actorId: user }] };
    if (normalized.includes("crm_lock_active_member")) return { rows: memberActive ? [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: null }] : [] };
    if (normalized.startsWith("select id,provider,account_label") && normalized.includes("for update")) return { rows: [{ id, provider, accountLabel: label, status, scopes: provider === "google" ? ["https://www.googleapis.com/auth/gmail.readonly"] : ["Mail.Read"], access, refresh, expiresAt: new Date(legacy ? Date.now() + 3600000 : 0).toISOString(), revision, nextCursor: null, format: provider === "google" ? "legacy" : "immutable", tenantId: legacy ? null : tenant, subject: legacy ? null : subject, accountId: legacy ? null : account }] };
    if (normalized.startsWith("select id,status,request_hash")) return { rows: [] };
    if (normalized.startsWith("select coalesce(sync_lease_until>clock_timestamp()")) { assert.deepEqual(args, [id, ws, user, revision]); return { rows: [{ busy: mode === "busy-after-lock" }] }; }
    if (normalized.startsWith("insert into crm_mailbox_sync_runs")) return { rows: [] };
    if (normalized.startsWith("update crm_mailbox_connections set sync_lease_id")) { assert.match(normalized, /sync_lease_until=clock_timestamp\(\)\+interval '2 minutes'/); assert.match(normalized, /workspace_id=\$3::uuid and user_id=\$4::uuid and status='connected' and revision=\$5/); assert.match(normalized, /sync_lease_until is null or sync_lease_until<=clock_timestamp\(\)/); assert.match(normalized, /returning revision/); if (mode === "claim-denied") return { rows: [] }; lease = String(args[1]); revision++; return { rows: [{ revision }] }; }
    if (normalized.startsWith("select to_jsonb(crm_mailbox_connections)")) { const active = !leaseExpired && revision === args[3] && lease === args[4]; if (mode === "lock-wait-expired" || mode === "final-wait-expired" && writes > 0 || (mode === "google-final-expired" || mode === "legacy-final-expired") && pages > 0) leaseExpired = true; return { rows: active ? [{ tenantId: legacy ? null : tenant, subject: legacy ? null : currentSubject, accountId: legacy ? null : account }] : [] }; }
    if (normalized.startsWith("select revision from crm_mailbox_connections")) { assert.match(normalized, /sync_lease_until>clock_timestamp\(\)/); return { rows: !leaseExpired && revision === args[3] && lease === args[4] ? [{ revision }] : [] }; }
    if (normalized.startsWith("update crm_mailbox_connections set revision=revision+1,access_token_encrypted")) { assert.match(normalized, /sync_lease_until>clock_timestamp\(\).*returning revision/); assert.match(normalized, /workspace_id=\$2::uuid and user_id=\$3::uuid and status='connected' and revision=\$4 and sync_lease_id=\$5::uuid/); if (leaseExpired || revision !== args[3] || lease !== args[4]) return { rows: [] }; access = String(args[5]); refresh = String(args[6]); writes++; revision++; return { rows: [{ revision }] }; }
    if (normalized.startsWith("update crm_mailbox_messages set provider_id_format")) return { rows: [] };
    if (normalized.startsWith("update crm_mailbox_connections set next_cursor")) { assert.match(normalized, /sync_lease_until>clock_timestamp\(\).*returning revision/); assert.match(normalized, /workspace_id=\$7::uuid and user_id=\$8::uuid and status='connected' and revision=\$9 and sync_lease_id=\$10::uuid/); if (leaseExpired || revision !== args[8] || lease !== args[9]) return { rows: [] }; lease = null; revision++; return { rows: [{ revision }] }; }
    if (normalized.startsWith("update crm_mailbox_sync_runs set status='succeeded'")) return { rows: [] };
    if (normalized.startsWith("update crm_mailbox_sync_runs set status='failed'")) return { rows: [] };
    if (normalized.startsWith("update crm_mailbox_connections set last_error")) {
      if (lease === args[1]) {
        lastError=String(args[2]);
        if(args[3]===true){status="reauthorization_required";if(normalized.includes("access_token_encrypted=case"))access=null;if(normalized.includes("refresh_token_encrypted=case"))refresh=null;}
        // Approximation of the 170 invariant; only actual PostgreSQL can prove it.
        if(status!=="connected"&&(access!==null||refresh!==null))throw new Error("synthetic trigger: non-connected mailbox must not retain tokens");
        lease=null;revision++;
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected synthetic query: ${normalized.slice(0, 100)}`);
  } }; } } as unknown as TenantPool;
  const transport: MailboxTransport = async (url) => {
    providerCalls++;
    if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "NEW_ACCESS", ...(mode === "no-rotation" ? {} : { refresh_token: mode === "empty-refresh" ? "" : "NEW_REFRESH" }), id_token: "synthetic-id", expires_in: 3600, scope: "Mail.Read" });
    if (url.includes("/v1.0/me?$select=id")) { if (mode === "lease-replaced") lease = randomUUID(); if (mode === "lease-expired") leaseExpired = true; if (mode === "identity-changed") currentSubject = "other-subject"; if (mode === "member-revoked") memberActive = false; return Response.json({ id: mode === "account-changed" ? randomUUID() : account, mail: label }); }
    if (provider === "google" && url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) { pages++; return Response.json({ messages: [] }); }
    if (["success", "final-wait-expired", "legacy-success", "legacy-final-expired"].includes(mode) && url.includes("/mailFolders/inbox?$select=id")) return Response.json({ id: "SYNTHETIC_INBOX" });
    if (["success", "final-wait-expired", "legacy-success", "legacy-final-expired"].includes(mode) && url.includes("/mailFolders/inbox/messages?")) { pages++; return Response.json({ value: [] }); }
    pages++; return new Response("temporarily unavailable", { status: 503 });
  };
  return { pool, transport, get writes() { return writes; }, get pages() { return pages; }, get providerCalls() { return providerCalls; }, get status() { return status; }, get lastError() { return lastError; }, get refresh() { return unprotectMailboxToken(session, provider, refresh, label); }, get access() { return unprotectMailboxToken(session, provider, access, label); }, verifier: mode === "verification-fails" ? async () => { throw new Error("synthetic verification failure"); } : verify };
}

test("manual sync keeps credentials and reports host configuration failure as temporary", async () => {
  const f=fixture("normal");
  await assert.rejects(syncCrmMailbox(session,{connectionId:id,requestId:randomUUID(),mode:"latest"},{pool:f.pool},f.transport,f.verifier,async()=>{throw new Error("synthetic SDK failure");}),{code:"MAIL_OAUTH_NOT_CONFIGURED",status:503,message:/Postfachabruf nicht bestätigt/});
  assert.equal(f.status,"connected");assert.equal(f.lastError,"MAIL_OAUTH_NOT_CONFIGURED");assert.equal(f.providerCalls,0);assert.equal(f.access,"OLD_ACCESS");assert.equal(f.refresh,"OLD_REFRESH");
});

const refreshFailures = [
  { label: "invalid client", status: 401, body: { error: "invalid_client", error_codes: [7000215] }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "invalid request", status: 400, body: { error: "invalid_request", error_codes: [50173] }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "temporary provider failure", status: 400, body: { error: "temporarily_unavailable" }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "ambiguous invalid grant", status: 400, body: { error: "invalid_grant" }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "conflicting invalid grant codes", status: 400, body: { error: "invalid_grant", error_codes: [50173, 7000215] }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "non-numeric diagnostic code", status: 400, body: { error: "invalid_grant", error_codes: ["700082"] }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "mismatched HTTP status", status: 403, body: { error: "invalid_grant", error_codes: [50173] }, code: "MAIL_PROVIDER_UNAVAILABLE" },
  { label: "oversized provider error", status: 400, body: { error: "invalid_grant", error_codes: [50173], extra: "x".repeat(16_384) }, code: "MAIL_RESPONSE_TOO_LARGE" },
  { label: "confirmed expired refresh grant", status: 400, body: { error: "invalid_grant", error_codes: [700082] }, code: "MAIL_REAUTH_REQUIRED" },
] as const;

for (const scenario of refreshFailures) test(`verified manual refresh handles ${scenario.label} with no provider diagnostics disclosed`, async () => {
  const f = fixture("normal");
  let calls = 0;
  const providerDescription = "synthetic private provider diagnostic";
  const transport: MailboxTransport = async (url, init) => {
    calls++;
    assert.equal(url, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
    assert.equal((init.body as URLSearchParams).get("grant_type"), "refresh_token");
    return Response.json({ ...scenario.body, error_description: providerDescription }, { status: scenario.status });
  };
  const reauthorize = scenario.code === "MAIL_REAUTH_REQUIRED";
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, transport, f.verifier, auth), (failure: unknown) => {
    assert.ok(failure instanceof Error);
    assert.deepEqual({ code: Reflect.get(failure, "code"), status: Reflect.get(failure, "status") }, { code: scenario.code, status: reauthorize ? 409 : 503 });
    assert.ok(!JSON.stringify(failure).includes(providerDescription) && !failure.message.includes(providerDescription));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(f.lastError, scenario.code);
  assert.equal(f.status, reauthorize ? "reauthorization_required" : "connected");
  assert.equal(f.access, reauthorize ? null : "OLD_ACCESS");
  assert.equal(f.refresh, reauthorize ? null : "OLD_REFRESH");
});

const malformedRefreshReplies = [
  { idToken: undefined, refreshToken: "UNVERIFIED_REFRESH" },
  { idToken: "", refreshToken: "UNVERIFIED_REFRESH" },
  { idToken: " \t", refreshToken: "UNVERIFIED_REFRESH" },
  { idToken: 123, refreshToken: "UNVERIFIED_REFRESH" },
  { idToken: "synthetic-id", refreshToken: "invalid replacement" },
  { idToken: "synthetic-id", refreshToken: 123 },
] as const;
for (const { idToken, refreshToken } of malformedRefreshReplies) test(`verified manual refresh retains the connection with malformed credentials (${JSON.stringify({ idToken, refreshToken })})`, async () => {
  const f = fixture("normal");
  let calls = 0;
  const transport: MailboxTransport = async (url) => {
    calls++;
    assert.equal(url, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
    return Response.json({ access_token: "UNVERIFIED_ACCESS", refresh_token: refreshToken, id_token: idToken, expires_in: 3600, scope: "Mail.Read" });
  };
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, transport, async () => assert.fail("malformed reply must not be passed to the verifier"), auth), { code: "MAIL_PROVIDER_UNAVAILABLE", status: 503 });
  assert.equal(calls, 1);
  assert.equal(f.status, "connected");
  assert.equal(f.lastError, "MAIL_PROVIDER_UNAVAILABLE");
  assert.equal(f.access, "OLD_ACCESS");
  assert.equal(f.refresh, "OLD_REFRESH");
  assert.equal(f.writes, 0);
  assert.equal(f.pages, 0);
});

test("manual sync keeps unknown AUTH-named failure fail-closed", async () => {
  const f=fixture("normal");let calls=0;
  const transport:MailboxTransport=async()=>{calls++;throw Object.assign(new Error("synthetic"),{code:"MAIL_UNKNOWN_AUTH_FAILURE"});};
  await assert.rejects(syncCrmMailbox(session,{connectionId:id,requestId:randomUUID(),mode:"latest"},{pool:f.pool},transport,f.verifier,auth),{code:"MAIL_UNKNOWN_AUTH_FAILURE",status:409});
  assert.equal(calls,1);assert.equal(f.status,"reauthorization_required");assert.equal(f.access,null);assert.equal(f.refresh,null);
  await assert.rejects(syncCrmMailbox(session,{connectionId:id,requestId:randomUUID(),mode:"latest"},{pool:f.pool},transport,f.verifier,auth));assert.equal(calls,1);
});

test("verified manual refresh commits replacement before a later provider failure", async () => {
  const f = fixture("normal");
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth), /Postfachabruf/);
  assert.equal(f.writes, 1); assert.equal(f.pages, 1); assert.equal(f.refresh, "NEW_REFRESH"); assert.equal(f.access, "NEW_ACCESS");
});

test("verified manual refresh keeps the lease revision valid for a successful empty page", async () => {
  const f = fixture("success");
  const result = await syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth);
  assert.equal(result.status, "succeeded"); assert.equal(result.importedCount, 0); assert.equal(f.writes, 1); assert.equal(f.pages, 1); assert.equal(f.refresh, "NEW_REFRESH");
});

test("verified manual refresh preserves the prior refresh token if none is returned", async () => {
  const f = fixture("no-rotation");
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth), /Postfachabruf/);
  assert.equal(f.writes, 1); assert.equal(f.refresh, "OLD_REFRESH"); assert.equal(f.access, "NEW_ACCESS");
});

test("final page cannot be reported successful if its lease expires while acquiring the row lock", async () => {
  const f = fixture("final-wait-expired");
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth), /Postfachidentität oder Abrufberechtigung/);
  assert.equal(f.writes, 1); assert.equal(f.pages, 1); assert.equal(f.refresh, "NEW_REFRESH");
});

test("Google manual pages also require a current lease", async () => {
  const ok = fixture("google-success");
  const result = await syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: ok.pool }, ok.transport, ok.verifier, auth);
  assert.equal(result.status, "succeeded"); assert.equal(ok.pages, 1);
  const stale = fixture("google-final-expired");
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: stale.pool }, stale.transport, stale.verifier, auth), /Postfachidentität oder Abrufberechtigung/);
  assert.equal(stale.pages, 1); assert.equal(stale.refresh, "OLD_REFRESH");
});

test("legacy Microsoft manual pages also require a current lease", async () => {
  const savedMode = process.env.MICROSOFT_MAILBOX_IDENTITY_MODE;
  const savedLegacy = process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY;
  const dedicatedKeys = ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET"] as const;
  const savedDedicated = dedicatedKeys.map(key => process.env[key]);
  for (const key of dedicatedKeys) delete process.env[key];
  process.env.MICROSOFT_MAILBOX_IDENTITY_MODE = "";
  process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = "1";
  try {
    const ok = fixture("legacy-success");
    const result = await syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: ok.pool }, ok.transport, ok.verifier, auth);
    assert.equal(result.status, "succeeded"); assert.equal(ok.pages, 1);
    const stale = fixture("legacy-final-expired");
    await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: stale.pool }, stale.transport, stale.verifier, auth), /Postfachidentität oder Abrufberechtigung/);
    assert.equal(stale.pages, 1); assert.equal(stale.refresh, "OLD_REFRESH");
  } finally { if (savedMode === undefined) delete process.env.MICROSOFT_MAILBOX_IDENTITY_MODE; else process.env.MICROSOFT_MAILBOX_IDENTITY_MODE = savedMode; if (savedLegacy === undefined) delete process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY; else process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = savedLegacy; dedicatedKeys.forEach((key, index) => { if (savedDedicated[index] === undefined) delete process.env[key]; else process.env[key] = savedDedicated[index]; }); }
});

for (const mode of ["empty-refresh", "lease-replaced", "lease-expired", "lock-wait-expired", "identity-changed", "account-changed", "member-revoked", "verification-fails"] as const) test(`manual refresh fails closed when ${mode}`, async () => {
  const f = fixture(mode);
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth));
  assert.equal(f.writes, 0); assert.equal(f.pages, 0); assert.equal(f.refresh, mode === "verification-fails" ? null : "OLD_REFRESH");
});

for (const mode of ["claim-denied", "busy-after-lock", "preflight-expired", "preflight-replaced", "preflight-revision", "preflight-identity"] as const) test(`manual claim fails closed before provider I/O: ${mode}`, async () => {
  const f = fixture(mode);
  await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool: f.pool }, f.transport, f.verifier, auth), /Postfach/);
  assert.equal(f.providerCalls, 0); assert.equal(f.writes, 0); assert.equal(f.refresh, "OLD_REFRESH");
});

test("manual sync rejects a nested transaction before pool or provider access", async () => {
  let calls=0;
  const pool={async connect(){calls++;throw new Error("unexpected pool access");}} as unknown as TenantPool;
  const transport:MailboxTransport=async()=>{calls++;throw new Error("unexpected provider access");};
  await assert.rejects(runWithTenantTransaction({actorId:user,workspaceId:ws},{} as TenantTransaction,()=>syncCrmMailbox(session,{connectionId:id,requestId:randomUUID(),mode:"latest"},{pool},transport,verify,auth)),/eigene kurze Transaktionen/);
  assert.equal(calls,0);
});
