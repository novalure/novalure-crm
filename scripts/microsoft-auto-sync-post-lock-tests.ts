import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { assertMailboxLeaseAfterLock } from "../src/lib/db/crm-mailbox-lease-wall-clock";
import { protectMailboxToken } from "../src/lib/db/crm-mailbox-repository";
import { runPersonalMailboxSync } from "../src/lib/db/crm-mailbox-sync-repository";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { MailboxProviderError, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";

// All identities, the pool, and the provider are synthetic. This cannot model
// PostgreSQL lock queues, transaction rollback, RLS, or Microsoft behavior.
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-auto-sync-post-lock-key";
process.env.MICROSOFT_MAILBOX_IDENTITY_MODE = "";
process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = "1";
for (const key of ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET"]) delete process.env[key];
const workspaceId = randomUUID(), userId = randomUUID(), identityId = randomUUID(), id = randomUUID(), lease = randomUUID(), accountId = randomUUID();
const session = { authenticated:true,workspaceId,userId,authIdentityId:identityId,workspaceName:"Synthetic",email:"synthetic@example.invalid",name:"Synthetic",source:"database",role:"owner",productRole:"customer_owner",permissions:["crm:read"],productPermissions:[] } as AppSession;

test("post-lock check requires scoped connection, exact revision, lease and database wall clock", async () => {
  const input = { id, workspaceId, userId, revision: 8, lease };
  let result: { revision: number } | null = { revision: 8 };
  const tx = { async queryOne(sql: string, args: readonly unknown[]) {
    assert.match(sql, /workspace_id=\$2::uuid and user_id=\$3::uuid/);
    assert.match(sql, /status='connected' and revision=\$4 and sync_lease_id=\$5::uuid and sync_lease_until>clock_timestamp\(\)/);
    assert.deepEqual(args, [id, workspaceId, userId, 8, lease]);
    return result;
  } } as unknown as TenantTransaction;
  await assertMailboxLeaseAfterLock(tx, input);
  result = null;
  await assert.rejects(assertMailboxLeaseAfterLock(tx, input), /Persönliche Freigabe/);
  result = { revision: 9 };
  await assert.rejects(assertMailboxLeaseAfterLock(tx, input), /Persönliche Freigabe/);
});

test("automatic legacy sync rejects missing explicit exception before any write or provider access", async () => {
  const previous = process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY;
  delete process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY;
  let writes = 0, providerCalls = 0, assertions = 0, sawRollback = false;
  const pool = { async connect() { return { release() {}, async query(sql: string) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from pg_roles runtime_role")) return { rows: [{ safe: true }] };
    if (q === "begin" || q === "rollback") { if (q === "rollback") sawRollback = true; return { rows: [], command: q.toUpperCase() }; }
    if (q.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId, actorId: userId }] };
    if (q.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: identityId }] };
    if (q.includes("to_regclass('public.crm_mailbox_auto_settings')")) return { rows: [{ ready: true }] };
    if (q.startsWith("select c.id,c.provider") && q.includes("for update of c,s")) return { rows: [{ id, provider: "microsoft", tenantId: null, subject: null, label: session.email, accountId, format: "immutable", access: "synthetic", refresh: "synthetic", scopes: ["Mail.Read"], expiresAt: new Date(Date.now() + 3600000).toISOString(), revision: 3, policyRevision: 4, identityId, autoFile: false, contactReview: false, backfillReplaying: false, failures: 0, enabled: true, due: true, busy: false }] };
    if (/^(update|insert|delete) /.test(q)) writes++;
    throw new Error("unexpected synthetic query");
  } }; } } as unknown as TenantPool;
  const transport: MailboxTransport = async () => { providerCalls++; throw new Error("unexpected provider call"); };
  const microsoftAuth = async () => { assertions++; throw new Error("unexpected assertion"); };
  try {
    await assert.rejects(runPersonalMailboxSync(session, id, { pool, transport, microsoftAuth, ignoreDue: true }), /MAIL_OAUTH_CONFIG/);
    assert.ok(sawRollback); assert.equal(writes, 0); assert.equal(providerCalls, 0); assert.equal(assertions, 0);
  } finally { if (previous === undefined) delete process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY; else process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = previous; }
});

for (const mode of ["configuration", "scope", "unknown-auth", "entra-client", "entra-expired"] as const) test(`automatic sync handles ${mode} without relaxing other auth failures`, async () => {
  const verified = mode === "entra-client" || mode === "entra-expired";
  const binding = { tenantId: verified ? workspaceId : null, subject: verified ? "synthetic-subject" : null, accountId };
  let revision=3,policyRevision=4,leaseId:string|null=null,status="connected",policyStatus="",lastError="",providerCalls=0;
  let access=protectMailboxToken(session,"microsoft","SYNTHETIC_ACCESS",session.email),refresh=protectMailboxToken(session,"microsoft","SYNTHETIC_REFRESH",session.email);
  const priorAccess=access,priorRefresh=refresh;
  const pool={async connect(){return {release(){},async query(sql:string,args:unknown[]=[]){
    const q=sql.replace(/\s+/g," ").trim().toLowerCase();
    if(q.includes("from pg_roles runtime_role"))return {rows:[{safe:true}]};
    if(q==="begin"||q==="commit"||q==="rollback")return {rows:[],command:q.toUpperCase()};
    if(q.includes("set_config('app.tenant_id'"))return {rows:[{workspaceId,actorId:userId}]};
    if(q.includes("crm_lock_active_member"))return {rows:[{role:"owner",productRole:"customer_owner",operatingModel:"self_service_customer",authIdentityId:identityId}]};
    if(q.includes("to_regclass('public.crm_mailbox_auto_settings')"))return {rows:[{ready:true}]};
    if(q.startsWith("select c.id,c.provider")&&q.includes("for update of c,s"))return {rows:status==="connected"?[{id,provider:"microsoft",...binding,label:session.email,format:"immutable",access,refresh,scopes:["Mail.Read"],expiresAt:new Date(mode==="unknown-auth"?Date.now()+3600000:0).toISOString(),revision,policyRevision,identityId,autoFile:false,contactReview:false,backfillReplaying:false,failures:0,enabled:true,due:true,busy:false}]:[]};
    if(q.startsWith("select checkpoint from crm_mailbox_auto_checkpoints"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id=$2::uuid")){leaseId=String(args[1]);revision++;return {rows:[{revision}]};}
    if(q.startsWith("select to_jsonb(c)")&&q.includes("for update of c,s"))return {rows:[binding]};
    if(q.startsWith("select revision from crm_mailbox_connections"))return {rows:[{revision}]};
    if(q.startsWith("select id from crm_mailbox_private_decisions"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_auto_settings set status=")){policyStatus=String(args[1]);lastError=String(args[2]);policyRevision++;return {rows:[{revision:policyRevision}]};}
    if(q.startsWith("delete from crm_mailbox_private_decisions"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id=null")){
      assert.equal(args[7],leaseId);if(args[3]===true){status="reauthorization_required";if(q.includes("access_token_encrypted=case"))access=null;if(q.includes("refresh_token_encrypted=case"))refresh=null;}
      // Model migration 170's invariant in the fake; this does not execute a real trigger.
      if(status!=="connected"&&(access!==null||refresh!==null))throw new Error("synthetic trigger: non-connected mailbox must not retain tokens");
      revision++;return {rows:[{revision}]};
    }
    throw new Error(`Unexpected synthetic query: ${q.slice(0,100)}`);
  }};}} as unknown as TenantPool;
  const transport: MailboxTransport = async (url) => {
    providerCalls++;
    if (mode === "unknown-auth") throw new MailboxProviderError("MAIL_UNKNOWN_AUTH_FAILURE");
    if (mode === "scope") return Response.json({ access_token: "synthetic-new", refresh_token: "synthetic-new-refresh", expires_in: 3600, scope: "Calendar.Read" });
    if (verified) {
      assert.equal(url, `https://login.microsoftonline.com/${workspaceId}/oauth2/v2.0/token`);
      return Response.json(mode === "entra-client"
        ? { error: "invalid_client", error_codes: [7000215] }
        : { error: "invalid_grant", error_codes: [50173] }, { status: 400 });
    }
    throw new Error("unexpected synthetic provider call");
  };
  const microsoftAuth=async()=>{if(mode==="configuration")throw new Error("synthetic unclassified SDK outage");return {client_id:"synthetic-client",client_secret:"synthetic-secret"};};
  const verifiedEnv = { MICROSOFT_MAILBOX_ALLOW_LEGACY: "0", MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-client", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", VERCEL: "1", VERCEL_ENV: "preview" };
  const previous = new Map(Object.keys(verifiedEnv).map(key => [key, process.env[key]]));
  if (verified) Object.assign(process.env, verifiedEnv);
  try {
    await assert.rejects(runPersonalMailboxSync(session,id,{pool,transport,microsoftAuth,ignoreDue:true}));
    const requiresReauth=mode!=="configuration"&&mode!=="entra-client";
    assert.equal(policyStatus,requiresReauth?"reauthorization_required":"delayed");assert.equal(status,requiresReauth?"reauthorization_required":"connected");
    assert.equal(lastError,({configuration:"MAIL_OAUTH_NOT_CONFIGURED",scope:"MAIL_SCOPE_REQUIRED","unknown-auth":"MAIL_UNKNOWN_AUTH_FAILURE","entra-client":"MAIL_PROVIDER_UNAVAILABLE","entra-expired":"MAIL_REAUTH_REQUIRED"})[mode]);
    assert.equal(access,requiresReauth?null:priorAccess);assert.equal(refresh,requiresReauth?null:priorRefresh);
    assert.equal(providerCalls,mode==="configuration"?0:1);
    if(requiresReauth){const priorCalls=providerCalls;assert.equal((await runPersonalMailboxSync(session,id,{pool,transport,microsoftAuth,ignoreDue:true})).status,"quiet");assert.equal(providerCalls,priorCalls);}
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

for(const mode of ["post-lock-expired","claim-denied"] as const)test(`automatic sync fails closed before provider access: ${mode}`, async () => {
  let revision = 3, currentLease: string | null = null, lockObserved = false, guardedWrites = 0, providerCalls = 0;
  const access = protectMailboxToken(session, "microsoft", "SYNTHETIC_ACCESS", session.email);
  const refresh = protectMailboxToken(session, "microsoft", "SYNTHETIC_REFRESH", session.email);
  const pool = { async connect() { return { release() {}, async query(sql: string, args: unknown[] = []) {
    const q=sql.replace(/\s+/g," ").trim().toLowerCase();
    if(q.includes("from pg_roles runtime_role")) return {rows:[{safe:true}]};
    if(q==="begin"||q==="commit"||q==="rollback") return {rows:[],command:q.toUpperCase()};
    if(q.includes("set_config('app.tenant_id'")) return {rows:[{workspaceId,actorId:userId}]};
    if(q.includes("crm_lock_active_member")) return {rows:[{role:"owner",productRole:"customer_owner",operatingModel:"self_service_customer",authIdentityId:identityId}]};
    if(q.includes("to_regclass('public.crm_mailbox_auto_settings')")) return {rows:[{ready:true}]};
    if(q.startsWith("select c.id,c.provider") && q.includes("for update of c,s")) return {rows:[{id,provider:"microsoft",tenantId:null,subject:null,label:session.email,accountId,format:"immutable",access,refresh,scopes:["Mail.Read"],expiresAt:new Date(Date.now()+3600000).toISOString(),revision,policyRevision:4,identityId,autoFile:false,contactReview:false,backfillReplaying:false,failures:0,enabled:true,due:true,busy:false}]};
    if(q.startsWith("select checkpoint from crm_mailbox_auto_checkpoints")) return {rows:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id")){assert.match(q,/sync_lease_until=clock_timestamp\(\)\+interval '2 minutes'/);assert.match(q,/c\.sync_lease_until<=clock_timestamp\(\)/);assert.match(q,/crm_mailbox_delegated_identity/);assert.match(q,/returning c\.revision/);if(mode==="claim-denied")return {rows:[]};currentLease=String(args[1]);revision++;return {rows:[{revision}]};}
    if(q.startsWith("select to_jsonb(c)") && q.includes("for update of c,s")){assert.match(q,/sync_lease_until>clock_timestamp\(\)/);assert.equal(args[4],currentLease);lockObserved=true;return {rows:[{tenantId:null,subject:null,accountId}]};}
    if(q.startsWith("select revision from crm_mailbox_connections")){assert.ok(lockObserved);assert.match(q,/sync_lease_until>clock_timestamp\(\)/);return {rows:[]};}
    if(q.startsWith("update crm_mailbox_connections set provider_account_id")||q.startsWith("insert into crm_mailbox_auto_checkpoints"))guardedWrites++;
    throw new Error(`Unexpected synthetic query: ${q.slice(0,100)}`);
  } }; } } as unknown as TenantPool;
  const transport:MailboxTransport=async(url)=>{providerCalls++;assert.ok(url.includes("/v1.0/me?$select=id"));return Response.json({id:accountId,mail:session.email});};
  await assert.rejects(runPersonalMailboxSync(session,id,{pool,transport,ignoreDue:true}),/Persönliche Freigabe/);
  assert.equal(lockObserved,mode==="post-lock-expired"); assert.equal(guardedWrites,0); assert.equal(providerCalls,0);
});

test("automatic sync refuses nested transactions before any provider or pool access", async () => {
  let calls=0;
  const pool={async connect(){calls++;throw new Error("unexpected pool access");}} as unknown as TenantPool;
  const tx={} as TenantTransaction;
  await assert.rejects(runWithTenantTransaction({actorId:userId,workspaceId},tx,()=>runPersonalMailboxSync(session,id,{pool,transport:async()=>{calls++;throw new Error("unexpected provider access");}})),/eigene kurze Transaktionen/);
  assert.equal(calls,0);
});

for (const verified of [false, true]) test(`automatic token work preserves the ${verified ? "verified" : "legacy"} account ID and rolls back on lease expiry`, async () => {
  let revision=3, snapshotRevision=revision, currentLease:string|null=null, expired=false, committedTokenWrite=false, snapshotWrite=false, providerCalls=0, rollbacks=0;
  const access=protectMailboxToken(session,"microsoft","SYNTHETIC_ACCESS",session.email), refresh=protectMailboxToken(session,"microsoft","SYNTHETIC_REFRESH",session.email);
  const bound = { tenantId: verified ? workspaceId : null, subject: verified ? "Synthetic-Subject" : null, accountId: verified ? "ABCDEF12-1234-4567-89AB-ABCDEF123456" : accountId };
  const pool={async connect(){return {release(){},async query(sql:string,args:unknown[]=[]){
    const q=sql.replace(/\s+/g," ").trim().toLowerCase();
    if(q.includes("from pg_roles runtime_role"))return {rows:[{safe:true}]};
    if(q==="begin"){snapshotRevision=revision;snapshotWrite=committedTokenWrite;return {rows:[],command:"BEGIN"};}
    if(q==="commit")return {rows:[],command:"COMMIT"};
    if(q==="rollback"){revision=snapshotRevision;committedTokenWrite=snapshotWrite;rollbacks++;return {rows:[],command:"ROLLBACK"};}
    if(q.includes("set_config('app.tenant_id'"))return {rows:[{workspaceId,actorId:userId}]};
    if(q.includes("crm_lock_active_member"))return {rows:[{role:"owner",productRole:"customer_owner",operatingModel:"self_service_customer",authIdentityId:identityId}]};
    if(q.includes("to_regclass('public.crm_mailbox_auto_settings')"))return {rows:[{ready:true}]};
    if(q.startsWith("select c.id,c.provider")&&q.includes("for update of c,s"))return {rows:[{id,provider:"microsoft",...bound,label:session.email,format:"immutable",access,refresh,scopes:["Mail.Read"],expiresAt:new Date(Date.now()+3600000).toISOString(),revision,policyRevision:4,identityId,autoFile:false,contactReview:false,backfillReplaying:false,failures:0,enabled:true,due:true,busy:false}]};
    if(q.startsWith("select checkpoint from crm_mailbox_auto_checkpoints"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id")){currentLease=String(args[1]);revision++;return {rows:[{revision}]};}
    if(q.startsWith("select to_jsonb(c)")&&q.includes("for update of c,s"))return {rows:expired?[]:[bound]};
    if(q.startsWith("select revision from crm_mailbox_connections"))return {rows:expired?[]:[{revision}]};
    if(q.startsWith("update crm_mailbox_connections set provider_account_id")){assert.equal(args[0],id);assert.equal(args[1],bound.accountId);committedTokenWrite=true;revision++;expired=true;return {rows:[]};}
    throw new Error(`Unexpected synthetic query: ${q.slice(0,100)}`);
  }};}} as unknown as TenantPool;
  const transport:MailboxTransport=async(url)=>{providerCalls++;assert.ok(url.includes("/v1.0/me?$select=id"));return Response.json({id:bound.accountId.toLowerCase(),mail:session.email});};
  const verifiedEnv = { MICROSOFT_MAILBOX_ALLOW_LEGACY: "0", MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-client", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", VERCEL: "1", VERCEL_ENV: "preview" };
  const previous = new Map(Object.keys(verifiedEnv).map(key => [key, process.env[key]]));
  if (verified) Object.assign(process.env, verifiedEnv);
  try {
    await assert.rejects(runPersonalMailboxSync(session,id,{pool,transport,ignoreDue:true}),/Persönliche Freigabe/);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.ok(currentLease); assert.equal(providerCalls,1); assert.equal(committedTokenWrite,false); assert.ok(rollbacks>=1);
});

for (const mode of ["lease-expired", "policy-denied", "commit-fails", "success", "pause"] as const) test(`automatic finish fences synthetic transaction: ${mode}`, async () => {
  let revision=3, policyRevision=4, leaseId:string|null=null, expired=false, settingsCommitted=false, snapshotPolicy=policyRevision, snapshotSettings=false, rollbackCount=0, finalGuardSeen=false;
  const queries:string[]=[];
  const access=protectMailboxToken(session,"microsoft","SYNTHETIC_ACCESS",session.email),refresh=protectMailboxToken(session,"microsoft","SYNTHETIC_REFRESH",session.email);
  const pool={async connect(){return {release(){},async query(sql:string,args:unknown[]=[]){
    const q=sql.replace(/\s+/g," ").trim().toLowerCase();queries.push(q.slice(0,100));
    if(q.includes("from pg_roles runtime_role"))return {rows:[{safe:true}]};
    if(q==="begin"){snapshotPolicy=policyRevision;snapshotSettings=settingsCommitted;return {rows:[],command:"BEGIN"};}
    if(q==="commit"){if(mode==="commit-fails"&&settingsCommitted)throw new Error("synthetic commit failure");return {rows:[],command:"COMMIT"};}
    if(q==="rollback"){policyRevision=snapshotPolicy;settingsCommitted=snapshotSettings;rollbackCount++;return {rows:[],command:"ROLLBACK"};}
    if(q.includes("set_config('app.tenant_id'"))return {rows:[{workspaceId,actorId:userId}]};
    if(q.includes("crm_lock_active_member"))return {rows:[{role:"owner",productRole:"customer_owner",operatingModel:"self_service_customer",authIdentityId:identityId}]};
    if(q.includes("to_regclass('public.crm_mailbox_auto_settings')"))return {rows:[{ready:true}]};
    if(q.startsWith("select c.id,c.provider")&&q.includes("for update of c,s"))return {rows:[{id,provider:"microsoft",tenantId:null,subject:null,label:session.email,accountId,format:"immutable",access,refresh,scopes:["Mail.Read"],expiresAt:new Date(Date.now()+3600000).toISOString(),revision,policyRevision,identityId,autoFile:false,contactReview:false,backfillReplaying:false,failures:0,enabled:true,due:true,busy:false}]};
    if(q.startsWith("select checkpoint from crm_mailbox_auto_checkpoints"))return {rows:mode==="pause"?[{checkpoint:{phase:"invalid"}}]:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id=$2::uuid")){leaseId=String(args[1]);revision++;return {rows:[{revision}]};}
    if(q.startsWith("select to_jsonb(c)")&&q.includes("for update of c,s"))return {rows:expired?[]:[{tenantId:null,subject:null,accountId}]};
    if(q.startsWith("select revision from crm_mailbox_connections"))return {rows:expired?[]:[{revision}]};
    if(q.startsWith("select id from crm_mailbox_private_decisions"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_auto_settings set status=")){assert.match(q,/revision=\$10 and identity_id=\$11::uuid and enabled returning revision/);assert.equal(args[6],mode==="pause");if(mode==="policy-denied")return {rows:[]};policyRevision++;settingsCommitted=true;expired=mode==="lease-expired";return {rows:[{revision:policyRevision}]};}
    if(q.startsWith("delete from crm_mailbox_private_decisions"))return {rows:[]};
    if(q.startsWith("update crm_mailbox_connections c set sync_lease_id=null")){finalGuardSeen=true;assert.match(q,/c\.revision=\$7 and c\.sync_lease_id=\$8::uuid and c\.sync_lease_until>clock_timestamp\(\)/);assert.match(q,/s\.revision=\$9 and s\.identity_id=\$10::uuid and s\.enabled=\(not \$11::boolean\)/);assert.match(q,/returning c\.revision/);assert.equal(args[7],leaseId);assert.equal(args[10],mode==="pause");return {rows:expired?[]:[{revision:revision+1}]};}
    throw new Error(`Unexpected synthetic query: ${q.slice(0,100)}`);
  }};}} as unknown as TenantPool;
  const transport:MailboxTransport=async()=>new Response("unavailable",{status:503});
  if(mode==="pause")assert.equal((await runPersonalMailboxSync(session,id,{pool,transport,ignoreDue:true})).status,"review");
  else await assert.rejects(runPersonalMailboxSync(session,id,{pool,transport,ignoreDue:true}),/MAIL_PROVIDER_UNAVAILABLE/);
  assert.equal(finalGuardSeen,mode!=="policy-denied",queries.join("\n"));
  const committed=mode==="success"||mode==="pause";
  assert.equal(settingsCommitted,committed);assert.equal(policyRevision,committed?5:4);
  if(!committed)assert.ok(rollbackCount>=1);
});
