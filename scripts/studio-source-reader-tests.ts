import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SignJWT, jwtVerify, type JWTVerifyOptions } from "jose";
import {
  CRM_MACHINE_AUDIENCE, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT,
  type CrmMachineAuthOptions,
} from "../src/lib/crm-machine-auth";
import type { TenantTransaction } from "../src/lib/crm-command";
import {
  assertStudioAcceptedTransfer, readStudioSource, studioSourcePath, studioSourcePreviewAudience,
} from "../src/lib/studio-source-reader";
import { studioEnquiryCrmProject, studioEnquiryProject } from "../src/lib/studio-enquiry-contract";
import { websiteSalesFormId, websiteSalesWorkspaceId } from "../src/lib/website-sales-ingestion";
import { LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const sourceSecret = Buffer.alloc(32, 1).toString("base64url");
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = new Date();
const host = "studio-source-synthetic.vercel.app";
const oldCursor = "1." + "a".repeat(64);
const newCursor = "2." + "b".repeat(64);
const event = {
  state: "accepted", workspaceId: websiteSalesWorkspaceId, crmProjectId: studioEnquiryCrmProject,
  operationId: randomUUID(), leadId: randomUUID(), submissionId: randomUUID(), revision: 1,
  acceptedAt: "2026-11-27T12:00:00.001Z", syntheticTest: false, payloadHash: "c".repeat(64),
};
const sourceGrantId = randomUUID();
type ReaderPool = NonNullable<Parameters<typeof readStudioSource>[1]>["pool"];
const verifier: NonNullable<CrmMachineAuthOptions["verifier"]> = async (jwt, options) =>
  jwtVerify(jwt, key.publicKey, options as JWTVerifyOptions) as ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>;

type CompiledStudioReader = (options: {
  origin: string; deploymentId: string; crmRevision: string; sourceGrantId: string; profile: "production";
  readGrantCredential: () => Promise<string>; getToken: (audience: string) => Promise<string>; fetch: typeof fetch;
  getTrustedSourceToken?: () => Promise<string>;
}) => (cursor: string | null) => Promise<unknown>;

async function loadPairedStudioReader() {
  const modulePath = process.env.CRM_PAIRED_EVELYN_MODULE;
  const evelynRevision = process.env.CRM_PAIRED_EVELYN_REVISION;
  const compiledSha256 = process.env.CRM_PAIRED_EVELYN_MODULE_SHA256;
  if (modulePath === undefined && evelynRevision === undefined && compiledSha256 === undefined) return null;
  assert.ok(modulePath && evelynRevision && /^[a-f0-9]{40}$/.test(evelynRevision) &&
    compiledSha256 && /^[a-f0-9]{64}$/.test(compiledSha256), "EXACT_COMPILED_EVELYN_SOURCE_COUNTERPART_REQUIRED");
  const counterpart = path.resolve(modulePath);
  const checkout = path.resolve(path.dirname(counterpart), "../../..");
  assert.equal(counterpart, path.join(checkout, "dist", "src", "production", "crm-studio-source-client.js"));
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(), evelynRevision);
  assert.equal(createHash("sha256").update(await readFile(counterpart)).digest("hex"), compiledSha256);
  const { createCrmStudioSourceReader } = await import(pathToFileURL(counterpart).href) as { createCrmStudioSourceReader: CompiledStudioReader };
  assert.equal(typeof createCrmStudioSourceReader, "function");
  return { createCrmStudioSourceReader, evelynRevision, compiledSha256 };
}

function runtime(profile: "production" | "preview" = "production", deploy = "dpl_Old") {
  return {
    NODE_ENV: "test" as const, VERCEL: "1", VERCEL_PROJECT_ID: studioEnquiryProject, VERCEL_ENV: profile, VERCEL_URL: host,
    VERCEL_DEPLOYMENT_ID: deploy, VERCEL_GIT_COMMIT_SHA: deploy === "dpl_Old" ? "a".repeat(40) : "b".repeat(40),
    CRM_MACHINE_AUTH_ENABLED: "1", CRM_STUDIO_SOURCE_ENABLED: "1", CRM_STUDIO_SOURCE_PREVIEW_ENABLED: "1",
    DATABASE_URL: "postgresql://novalure_app:test@ep-summer-dew-bht4t903-pooler.synthetic.neon.tech/neondb?sslmode=verify-full",
  };
}

async function token(profile: "production" | "preview", overrides = {}) {
  const seconds = Math.floor(now.valueOf() / 1000);
  const preview = profile === "preview";
  return new SignJWT({
    iss: CRM_MACHINE_ISSUER, aud: preview ? studioSourcePreviewAudience : CRM_MACHINE_AUDIENCE,
    sub: preview ? "owner:novalure:project:evelyn:environment:preview" : CRM_MACHINE_SUBJECT,
    project_id: CRM_MACHINE_PROJECT_ID, owner_id: CRM_MACHINE_OWNER_ID, environment: profile,
    iat: seconds, nbf: seconds, exp: seconds + 60, jti: randomUUID(), ...overrides,
  }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "synthetic" }).sign(key.privateKey);
}

function request(jwt: string, body: unknown = { cursor: null, limit: 1 }, hostname = host, credential = sourceSecret) {
  return new Request(`https://${hostname}${studioSourcePath}`, {
    method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-evelyn-studio-source": credential },
    body: JSON.stringify(body),
  });
}

function localPool(page: Record<string, unknown> | null, ready = true) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          calls.push({ sql, params });
          if (sql.includes("from pg_roles")) return { rows: [{ safe: true }] };
          if (sql.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId: params[0], actorId: params[1] }] };
          if (sql.includes("to_regprocedure")) return { rows: [{ ready }] };
          if (sql.startsWith("\n  with principal")) return { rows: page ? [page] : [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return { calls, pool: pool as unknown as ReaderPool };
}

test("SOURCE rejects missing production scope, foreign preview and request-selected CRM targets before SQL", async () => {
  const { pool, calls } = localPool(null);
  const prod = await token("production"), qa = await token("preview");
  for (const [req, env, status] of [
    [request(prod), { ...runtime(), CRM_STUDIO_SOURCE_ENABLED: "0" }, 503],
    [request(qa), runtime(), 401],
    [request(prod), runtime("preview"), 403],
    [request(qa, { cursor: null, limit: 1 }, "other.vercel.app"), runtime("preview"), 403],
    [request(prod, { cursor: null, limit: 1, workspaceId: randomUUID() }), runtime(), 400],
  ] as const) {
    assert.equal((await readStudioSource(req, { pool, env, verifier, now })).status, status);
  }
  assert.equal(calls.length, 0);
});

test("SOURCE scopes the read-only query to its current grant and preserves the saved cursor on a new build", async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://synthetic@127.0.0.1/synthetic";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const page = { events: [event], scopeValid: true, nextCursor: newCursor, hasMore: false, sourceGrantId };
  const { pool, calls } = localPool(page);
  const env = runtime("production", "dpl_New");
  const response = await readStudioSource(request(await token("production"), { cursor: oldCursor, limit: 1 }), { pool, env, verifier, now });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    events: [event], nextCursor: newCursor, hasMore: false, sourceGrantId,
    receiverDeploymentId: env.VERCEL_DEPLOYMENT_ID, receiverRevision: env.VERCEL_GIT_COMMIT_SHA,
  });
  assert.equal(calls[0]?.sql, "begin read only");
  const call = calls.find(x => x.sql.includes("with principal"));
  assert.equal(call?.params[1], "dpl_New");
  assert.equal(call?.params[4], oldCursor);
  assert.equal(call?.params[11], websiteSalesWorkspaceId);
  assert.equal(call?.params[15], studioEnquiryCrmProject);
  assert.ok(!calls.some(x => x.params.includes(sourceSecret)));
  assert.match(call?.sql ?? "", /source_seq > g\.after_seq/);
  assert.match(call?.sql ?? "", /'syntheticTest' = 'false'::jsonb/);
});

test("SOURCE exposes no data on revoked/missing grant, unavailable stage, or corrupted output", async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://synthetic@127.0.0.1/synthetic";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const env = runtime("preview");
  const jwt = await token("preview");
  assert.equal((await readStudioSource(request(jwt), { ...localPool(null), env, verifier, now })).status, 403);
  assert.equal((await readStudioSource(request(jwt), { ...localPool(null, false), env, verifier, now })).status, 503);
  for (const page of [
    { events: [{ ...event, snapshotText: "SYNTHETIC" }], scopeValid: true, nextCursor: newCursor, hasMore: false, sourceGrantId },
    { events: [event], scopeValid: false, nextCursor: newCursor, hasMore: false, sourceGrantId },
  ]) {
    const response = await readStudioSource(request(jwt), { ...localPool(page), env, verifier, now });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: "STUDIO_SOURCE_PAGE_UNCONFIRMED" });
  }
});

test("Sales exact receipt uses the already authenticated workload and active SOURCE grant", async () => {
  const workloadId = randomUUID();
  const calls: unknown[][] = [];
  const tx = { queryOne: async (_sql: string, params: unknown[] = []) => {
    calls.push(params);
    return params.length ? { matched: false } : { ready: true };
  } } as unknown as TenantTransaction;
  await assert.rejects(assertStudioAcceptedTransfer(tx, event, { workloadId, sourceGrantId }), /not confirmed/);
  assert.deepEqual(calls[1], [workloadId, sourceGrantId, event.workspaceId, event.crmProjectId,
    event.operationId, event.revision, event.payloadHash, event.leadId, event.submissionId, websiteSalesFormId]);
});

for (const profile of ["production", "preview"] as const) {
test(`native staged ${profile} SOURCE preserves activation and sealed progress through ordered commits and grant rotation`, async t => {
  const cluster = await startLocalSalesDb();
  const local = { host: "127.0.0.1", port: cluster.port, database: "neondb" };
  const runtimeConnection = new LocalSalesPool({ ...local, user: "novalure_app" });
  let adminConnection: LocalSalesPool | undefined, operatorConnection: LocalSalesPool | undefined;
  const previous = process.env.DATABASE_URL;
  t.after(async () => {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    try { await Promise.all([adminConnection?.end(), runtimeConnection?.end(), operatorConnection?.end()]); }
    finally { await cluster.stop(); }
  });
  process.env.DATABASE_URL = `postgresql://novalure_app@127.0.0.1:${cluster.port}/neondb`;
  await cluster.admin.query("create database neondb");
  await cluster.admin.query(`
    alter database neondb set neon.project_id = '${profile === "preview" ? "long-fog-84900593" : "misty-cloud-70835427"}';
    alter database neondb set neon.branch_id = '${profile === "preview" ? "br-summer-mountain-bh7w67e3" : "br-spring-night-alyu48yp"}';
    alter role novalure_app login;
    create role novalure_tenant_app nologin;
    grant novalure_tenant_app to novalure_app;
    create role studio_source_fixture_owner nologin noinherit;
  `);
  const admin = adminConnection = new LocalSalesPool({ ...local, user: "qa_admin" });
  const pool = runtimeConnection as unknown as ReaderPool;
  const workload = randomUUID();
  // A disposable PostgreSQL schema for the actual staged SQL and handler
  // query. It represents only the already-tested intake/auth predecessors.
  await admin.query(`
    create extension pgcrypto;
    create table workspace_users(id uuid, workspace_id uuid, status text, role text, product_role text);
    create table forms(id uuid, workspace_id uuid, project_id uuid, status text);
    create table leads(id uuid, workspace_id uuid, project_id uuid, metadata jsonb not null default '{}');
    create table form_submissions(id uuid, workspace_id uuid, project_id uuid, lead_id uuid, form_id uuid, mode text,
      deal_id uuid, contact_id uuid, raw_payload jsonb not null default '{}');
    create table studio_enquiry_transfers(operation_id uuid primary key, workspace_id uuid, revision integer, payload_hash text,
      snapshot_text text, state text, lead_id uuid, submission_id uuid, accepted_at timestamptz,
      targets jsonb not null default '[]',reference text not null default ('NL-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
      created_at timestamptz not null default now());
    alter table studio_enquiry_transfers enable row level security;
    alter table studio_enquiry_transfers force row level security;
    create policy studio_fixture_actor on studio_enquiry_transfers for select to novalure_tenant_app
      using (workspace_id::text = current_setting('app.tenant_id', true)
        and current_setting('app.actor_id', true) = '6122a6da-e7f4-47fa-bc55-e296bb01af62');
    grant select on workspace_users, forms, leads, form_submissions, studio_enquiry_transfers to novalure_tenant_app;
    create function public.crm_authenticate_autonomous_workload(text,text,text,text,text,uuid,text)
      returns table(id uuid, workspace_id uuid, identity_id text) language sql stable
      as 'select ''${workload}''::uuid, $6, ''EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'' where $7 = ''production''';
    grant create on schema public to studio_source_fixture_owner;
    alter table studio_enquiry_transfers owner to studio_source_fixture_owner;
  `);
  const intakeImmutable = (await readFile("migrations/100_studio_enquiry_production.sql", "utf8"))
    .match(/create function public\.studio_enquiry_immutable_confirmation\(\)[\s\S]*?\$fn\$;/)?.[0];
  assert.ok(intakeImmutable, "use the actual standalone intake's immutable accepted-row guard");
  await admin.query(intakeImmutable);
  await admin.query(`create trigger studio_enquiry_immutable before update on public.studio_enquiry_transfers
    for each row execute function public.studio_enquiry_immutable_confirmation();
    revoke all on function public.studio_enquiry_immutable_confirmation() from public`);
  await admin.query("insert into workspace_users values ('6122a6da-e7f4-47fa-bc55-e296bb01af62',$1,'active','agent','novalure_operator')", [websiteSalesWorkspaceId]);
  await admin.query("insert into forms values ($1,$2,$3,'aktiv')", [websiteSalesFormId, websiteSalesWorkspaceId, studioEnquiryCrmProject]);
  const add = async (syntheticTest: boolean, qaRunPrefix?: string) => {
    const item = { id: randomUUID(), lead: randomUUID(), submission: randomUUID() };
    const marker = qaRunPrefix ? { qaRunPrefix, isolatedProductionShapedFixture: true, productionCustomerTransfer: false } : {};
    await admin.query("insert into leads(id,workspace_id,project_id,metadata) values ($1,$2,$3,$4)", [item.lead, websiteSalesWorkspaceId, studioEnquiryCrmProject, marker]);
    await admin.query("insert into form_submissions(id,workspace_id,project_id,lead_id,form_id,mode,deal_id,contact_id,raw_payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [item.submission, websiteSalesWorkspaceId, studioEnquiryCrmProject, item.lead, websiteSalesFormId,
        syntheticTest ? "test" : "live", randomUUID(), randomUUID(), marker]);
    await admin.query("insert into studio_enquiry_transfers(operation_id,workspace_id,revision,payload_hash,snapshot_text,state,lead_id,submission_id,accepted_at) values ($1,$2,1,$3,$4,'reserved',$5,$6,null)",
      [item.id, websiteSalesWorkspaceId, event.payloadHash, JSON.stringify({ syntheticTest }), item.lead, item.submission]);
    return item.id;
  };
  const acceptSql = "update studio_enquiry_transfers set state='accepted',accepted_at=$2 where operation_id=$1";
  const accept = async (id: string, acceptedAt = event.acceptedAt) => admin.query(acceptSql, [id, acceptedAt]);
  await accept(await add(false)); // Historical row predating the stage.
  const install = await admin.connect();
  try {
    await install.query("begin");
    await install.query("set local role studio_source_fixture_owner");
    await install.query(await readFile("migrations/staged/evelyn_studio_source.sql", "utf8"));
    await install.query("commit");
  } finally { install.release(); }
  const owner = await admin.connect();
  try {
    await owner.query("set role studio_source_fixture_owner");
    const ownerPid = (await owner.query("select pg_backend_pid() as pid")).rows[0].pid;
    // This late equivalent of an already-in-flight intake holds the shared
    // media lock until the prior acceptance is committed.
    const before = await add(false);
    const writer = await admin.connect();
    let activation;
    try {
      await writer.query("begin");
      await writer.query(acceptSql, [before, event.acceptedAt]);
      activation = owner.query("insert into crm_studio_source_activation(profile) values ($1) returning starts_after", [profile]);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await admin.query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) as waiting", [ownerPid])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      await writer.query("commit");
      assert.equal((await activation).rows[0].starts_after, "1");
    } finally {
      try { await writer.query("rollback"); } finally { writer.release(); }
      await activation?.catch(() => {});
    }
    const qaRunPrefix = "GOLIVETEST_SOURCE_RETIRE_" + randomUUID().replaceAll("-", "");
    const first = await add(false, profile === "preview" ? qaRunPrefix : undefined), second = await add(false);
    await accept(first, "2026-11-27T12:00:01.009999Z");
    await accept(await add(true));
    await accept(second, "2026-11-27T12:00:00.001111Z"); // Earlier timestamp, later commit.
    await add(false); // Still reserved.
    const grant = async (deploy: string, credential: string, ownPrefix?: string) => {
      const env = runtime(profile, deploy), id = randomUUID();
      await owner.query(`insert into crm_studio_source_grants
        (id,profile,workload_id,workspace_id,crm_project_id,receiver_project,deployment_id,revision,credential_hash,authority_reference,expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '1 hour')`,
      [id, profile, profile === "preview" ? null : workload, websiteSalesWorkspaceId, studioEnquiryCrmProject, studioEnquiryProject, deploy, env.VERCEL_GIT_COMMIT_SHA,
        createHash("sha256").update(credential, "ascii").digest("hex"), ownPrefix ? ownPrefix + " own synthetic SOURCE read" : "synthetic exact grant"]);
      return { env, id };
    };
    const old = await grant("dpl_Old", sourceSecret, profile === "preview" ? qaRunPrefix : undefined);
    const jwt = await token(profile);
    if (profile === "preview") {
      assert.equal((await readStudioSource(request(jwt), { pool, env: old.env, verifier, now })).status, 503,
        "Preview fails closed while the additive retirement stage is absent");
      await admin.query(`create role neondb_owner login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
        grant studio_source_fixture_owner to neondb_owner;
        create table audit_logs(id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid,
          actor_user_id uuid,action text not null,entity_type text not null,entity_id uuid,before jsonb,after jsonb,
          created_at timestamptz not null default now());
        alter table audit_logs enable row level security;
        alter table audit_logs force row level security;
        grant usage on schema public to neondb_owner;
        grant select on leads,form_submissions to studio_source_fixture_owner;
        grant insert,select on audit_logs to neondb_owner;
        create policy source_qa_operator_audit on audit_logs to neondb_owner
          using (workspace_id='${websiteSalesWorkspaceId}'::uuid and project_id='${studioEnquiryCrmProject}'::uuid and actor_user_id is null)
          with check (workspace_id='${websiteSalesWorkspaceId}'::uuid and project_id='${studioEnquiryCrmProject}'::uuid and actor_user_id is null);`);
      const immutable = (await readFile("migrations/080_crm_command_safety.sql", "utf8"))
        .match(/create or replace function crm_reject_immutable_mutation\(\)[\s\S]*?end \$\$;/)?.[0];
      const auditImmutable = (await readFile("migrations/060_tenant_rls_pilot_prepare.sql", "utf8"))
        .match(/create or replace function reject_audit_logs_mutation\(\)[\s\S]*?\$function\$;/)?.[0];
      assert.ok(immutable && auditImmutable, "use the actual existing append-only guards");
      await admin.query(immutable);
      await admin.query(auditImmutable);
      await admin.query(`create trigger audit_logs_append_only_guard before update or delete or truncate on audit_logs
        for each statement execute function reject_audit_logs_mutation();
        grant execute on function crm_reject_immutable_mutation() to studio_source_fixture_owner`);
      const stageSql = await readFile("migrations/staged/evelyn_studio_source_qa_retirement.sql", "utf8");
      const matcher = "public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)";
      for (const [drift, restore] of [
        ["security invoker", "security definer"],
        ["set search_path=public,pg_catalog", "set search_path=pg_catalog,public"],
      ]) {
        await admin.query(`alter function ${matcher} ${drift}`);
        try {
          await owner.query("begin");
          try { await assert.rejects(owner.query(stageSql), /STUDIO_QA_RETIREMENT_INSTALLER_BOUNDARY/); }
          finally { await owner.query("rollback"); }
        } finally { await admin.query(`alter function ${matcher} ${restore}`); }
      }
      await owner.query("begin");
      try {
        await owner.query(stageSql);
        await owner.query("commit");
      } finally { await owner.query("rollback"); }
      operatorConnection = new LocalSalesPool({ ...local, user: "neondb_owner", max: 1 });
    }
    const firstPage = await readStudioSource(request(jwt), { pool, env: old.env, verifier, now });
    assert.equal(firstPage.status, 200);
    const one = await firstPage.json();
    assert.equal(one.events[0].operationId, first);
    assert.equal(one.events[0].acceptedAt, "2026-11-27T12:00:01.009Z");
    assert.equal(one.hasMore, true);

    const rotated = Buffer.alloc(32, 2).toString("base64url");
    const next = await grant("dpl_New", rotated);
    await owner.query("update crm_studio_source_grants set revoked_at = clock_timestamp() where id = $1", [old.id]);
    assert.equal((await readStudioSource(request(jwt), { pool, env: old.env, verifier, now })).status, 403);
    const continued = await readStudioSource(request(jwt, { cursor: one.nextCursor, limit: 1 }, host, rotated), { pool, env: next.env, verifier, now });
    assert.equal(continued.status, 200);
    const two = await continued.json();
    assert.equal(two.events[0].operationId, second);
    assert.equal(two.events[0].acceptedAt, "2026-11-27T12:00:00.001Z");
    assert.equal(two.hasMore, false);
    assert.equal(two.sourceGrantId, next.id);
    const paired = profile === "production" ? await loadPairedStudioReader() : null;
    if (paired) {
      const origin = "https://www.novalure-crm.app";
      const trustedSourceToken = "synthetic-vercel-platform-oidc";
      let reads = 0;
      const read = paired.createCrmStudioSourceReader({
        origin, deploymentId: next.env.VERCEL_DEPLOYMENT_ID, crmRevision: next.env.VERCEL_GIT_COMMIT_SHA,
        sourceGrantId: next.id, profile: "production", readGrantCredential: async () => rotated,
        getToken: async audience => { assert.equal(audience, CRM_MACHINE_AUDIENCE); return jwt; },
        getTrustedSourceToken: async () => trustedSourceToken,
        fetch: async (input, init) => {
          assert.equal(++reads, 1);
          assert.equal(String(input), `${origin}${studioSourcePath}`);
          const inbound = new Request(input, init);
          assert.equal(inbound.headers.get("x-vercel-trusted-oidc-idp-token"), trustedSourceToken);
          assert.deepEqual(await inbound.clone().json(), { cursor: one.nextCursor, limit: 1 });
          const response = await readStudioSource(inbound, { pool, env: next.env, verifier, now });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.clone().json(), two);
          return response;
        },
      });
      assert.deepEqual(await read(one.nextCursor), {
        crmRevision: next.env.VERCEL_GIT_COMMIT_SHA, crmDeploymentId: next.env.VERCEL_DEPLOYMENT_ID,
        sourceGrantId: next.id, transfer: two.events[0], nextCursor: two.nextCursor,
      });
      assert.equal(reads, 1);
      console.log("STUDIO_SOURCE_PAIRED_EVIDENCE " + JSON.stringify({
        evelynRevision: paired.evelynRevision, compiledSha256: paired.compiledSha256, reads,
        actualReceiver: true, actualPostgreSQL: true, scope: "SYNTHETIC_LOCAL_ONLY",
      }));
    } else {
      const retry = await readStudioSource(request(jwt, { cursor: one.nextCursor, limit: 1 }, host, rotated), { pool, env: next.env, verifier, now });
      assert.deepEqual(await retry.json(), two);
    }
    const forged = await readStudioSource(request(jwt, { cursor: "999." + one.nextCursor.split(".")[1], limit: 1 }, host, rotated), { pool, env: next.env, verifier, now });
    assert.equal(forged.status, 403);
    if (profile === "preview") await t.test("own QA retirement is exact, append-only and excluded before page limits without moving cursor positions", async () => {
      assert.ok(operatorConnection);
      const operator = operatorConnection;
      assert.deepEqual((await operator.query("select session_user,current_user")).rows,
        [{ session_user: "neondb_owner", current_user: "neondb_owner" }]);
      assert.deepEqual((await operator.query("select nullif(current_setting('app.tenant_id',true),'') as tenant, nullif(current_setting('app.actor_id',true),'') as actor")).rows,
        [{ tenant: null, actor: null }], "the technical operator begins without an application-user context");
      const originals = async () => (await admin.query(`select
        (select to_jsonb(t) from studio_enquiry_transfers t where operation_id=$1) as transfer,
        (select to_jsonb(l) from leads l where id=(select lead_id from studio_enquiry_transfers where operation_id=$1)) as lead,
        (select to_jsonb(s) from form_submissions s where id=(select submission_id from studio_enquiry_transfers where operation_id=$1)) as submission,
        (select to_jsonb(a) from crm_studio_source_activation a) as activation`, [first])).rows[0];
      const beforeOriginals = await originals();
      const tupleFor = async (operationId: string) => (await admin.query(`select operation_id as "operationId",workspace_id as "workspaceId",
        $2::uuid as "crmProjectId",revision,payload_hash as "payloadHash",lead_id as "leadId",submission_id as "submissionId",
        source_seq::text as "sourceSeq",to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "acceptedAt"
        from studio_enquiry_transfers where operation_id=$1`, [operationId, studioEnquiryCrmProject])).rows[0];
      const plan = { tuple: await tupleFor(first),
        originalGrant: { id: old.id, deploymentId: old.env.VERCEL_DEPLOYMENT_ID, revision: old.env.VERCEL_GIT_COMMIT_SHA },
        qaRunPrefix, provenanceSha256: "d".repeat(64), authoritySha256: "e".repeat(64), hostScopeDecisionSha256: "f".repeat(64),
        hostScopeDecision: "RETIRE_OWN_QA_NO_PENDING_PROMOTION",
        receiver: { deploymentId: next.env.VERCEL_DEPLOYMENT_ID, revision: next.env.VERCEL_GIT_COMMIT_SHA } };
      const retire = (input: unknown = plan) => operator.query("select public.crm_retire_studio_source_qa($1::jsonb) as audit", [JSON.stringify(input)]);
      const counts = async () => (await admin.query(`select (select count(*)::int from crm_studio_source_qa_retirements) as retirements,
        (select count(*)::int from audit_logs) as audits`)).rows[0];
      const empty = { retirements: 0, audits: 0 };
      await assert.rejects(retire(), /STUDIO_QA_RETIREMENT_CONSUMER_NOT_QUIET/,
        "an active rotated consumer blocks retirement even though the original grant is revoked");
      assert.deepEqual(await counts(), empty, "failed retirement rolls its audit insert back atomically");
      await owner.query("update crm_studio_source_grants set revoked_at=clock_timestamp() where id=$1", [next.id]);
      await assert.rejects(admin.query("select public.crm_retire_studio_source_qa($1::jsonb)", [JSON.stringify(plan)]), /STUDIO_QA_RETIREMENT_OPERATOR_TARGET/);
      const runtimeWriter = await runtimeConnection.connect();
      try {
        await runtimeWriter.query("begin");
        await runtimeWriter.query("set local role novalure_tenant_app");
        await runtimeWriter.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
          [websiteSalesWorkspaceId, "6122a6da-e7f4-47fa-bc55-e296bb01af62"]);
        await assert.rejects(runtimeWriter.query("select public.crm_retire_studio_source_qa($1::jsonb)", [JSON.stringify(plan)]), /permission denied/);
        await runtimeWriter.query("rollback");
        await runtimeWriter.query("begin");
        await runtimeWriter.query("set local role novalure_tenant_app");
        await assert.rejects(runtimeWriter.query("select * from public.crm_studio_source_qa_retirements"), /permission denied/,
          "runtime cannot read the operator-owned retirement ledger directly");
      } finally { await runtimeWriter.query("rollback"); runtimeWriter.release(); }
      for (const tupleChange of [
        { workspaceId: randomUUID() }, { crmProjectId: randomUUID() }, { operationId: randomUUID() },
        { revision: plan.tuple.revision + 1 }, { payloadHash: "0".repeat(64) }, { leadId: randomUUID() },
        { submissionId: randomUUID() }, { sourceSeq: String(BigInt(plan.tuple.sourceSeq) + BigInt(1)) },
        { acceptedAt: "2026-11-27T12:00:01.009000Z" },
      ]) await assert.rejects(retire({ ...plan, tuple: { ...plan.tuple, ...tupleChange } }));
      await assert.rejects(retire({ ...plan, tuple: await tupleFor(second) }), /STUDIO_QA_RETIREMENT_OWNERSHIP_UNPROVEN/,
        "accepted unmarked events cannot be retired using an own QA grant");
      await assert.rejects(retire({ ...plan, originalGrant: { ...plan.originalGrant, revision: "0".repeat(40) } }), /STUDIO_QA_RETIREMENT_ORIGINAL_CONFLICT/);
      await assert.rejects(retire({ ...plan, originalGrant: { ...plan.originalGrant, id: next.id } }), /STUDIO_QA_RETIREMENT_ORIGINAL_CONFLICT/,
        "another revoked grant with no matching ownership provenance cannot substitute for the original");
      const expiredUnrevoked = randomUUID();
      await owner.query(`insert into crm_studio_source_grants
        (id,profile,workload_id,workspace_id,crm_project_id,receiver_project,deployment_id,revision,credential_hash,authority_reference,expires_at)
        values($1,'preview',null,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '1 second')`,
      [expiredUnrevoked, websiteSalesWorkspaceId, studioEnquiryCrmProject, studioEnquiryProject,
        old.env.VERCEL_DEPLOYMENT_ID, old.env.VERCEL_GIT_COMMIT_SHA, "9".repeat(64), qaRunPrefix + " own synthetic SOURCE read"]);
      await assert.rejects(retire({ ...plan, originalGrant: { ...plan.originalGrant, id: expiredUnrevoked } }), /STUDIO_QA_RETIREMENT_ORIGINAL_CONFLICT/,
        "expiry alone does not substitute for revoking the original QA grant");
      await assert.rejects(retire({ ...plan, extra: true }), /STUDIO_QA_RETIREMENT_EXACT_PLAN/);
      await operator.query("set neon.branch_id='br-foreign'");
      try { await assert.rejects(retire(), /STUDIO_QA_RETIREMENT_OPERATOR_TARGET/); }
      finally { await operator.query("reset neon.branch_id"); }
      await admin.query("revoke insert on audit_logs from neondb_owner");
      try { await assert.rejects(retire(), /STUDIO_QA_RETIREMENT_OPERATOR_TARGET/); }
      finally { await admin.query("grant insert on audit_logs to neondb_owner"); }
      assert.deepEqual(await counts(), empty);
      const staleAuditReference = randomUUID();
      await operator.query(`insert into audit_logs(id,workspace_id,project_id,actor_user_id,action,entity_type,entity_id,after)
        values($1,$2,$3,null,'studio.source.qa.retire','studio_source_qa_retirement',$4,$5::jsonb)`,
      [staleAuditReference, websiteSalesWorkspaceId, studioEnquiryCrmProject, first,
        JSON.stringify({ actor: { type: "DATABASE_OPERATOR", sessionUser: "neondb_owner", databaseRole: "neondb_owner" },
          decision: "OWN_SOURCE_QA_RETIRED", plan })]);
      const priorAudit = (await admin.query("select to_jsonb(a) as original from audit_logs a where id=$1", [staleAuditReference])).rows[0].original;
      await assert.rejects(operator.query(`insert into crm_studio_source_qa_retirements
        (operation_id,workspace_id,crm_project_id,revision,payload_hash,lead_id,submission_id,source_seq,accepted_at,original_grant_id,plan,audit_reference)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [plan.tuple.operationId, plan.tuple.workspaceId, plan.tuple.crmProjectId, plan.tuple.revision, plan.tuple.payloadHash,
        plan.tuple.leadId, plan.tuple.submissionId, plan.tuple.sourceSeq, plan.tuple.acceptedAt, plan.originalGrant.id,
        JSON.stringify(plan), staleAuditReference]), /STUDIO_QA_RETIREMENT_OPERATOR_AUDIT_REQUIRED/,
      "a prior committed audit cannot substitute for the same-transaction operator audit");
      assert.deepEqual(await counts(), { retirements: 0, audits: 1 });
      const auditReference = (await retire()).rows[0].audit;
      assert.match(auditReference, /^[a-f0-9-]{36}$/);
      assert.equal((await retire()).rows[0].audit, auditReference, "identical replay reuses the durable audit reference");
      assert.deepEqual(await counts(), { retirements: 1, audits: 2 });
      await assert.rejects(retire({ ...plan, provenanceSha256: "0".repeat(64) }), /STUDIO_QA_RETIREMENT_CONFLICT/);
      const audit = (await admin.query("select actor_user_id,action,entity_type,entity_id,after from audit_logs where id=$1", [auditReference])).rows[0];
      assert.deepEqual(audit, { actor_user_id: null, action: "studio.source.qa.retire", entity_type: "studio_source_qa_retirement", entity_id: first,
        after: { actor: { type: "DATABASE_OPERATOR", sessionUser: "neondb_owner", databaseRole: "neondb_owner" }, decision: "OWN_SOURCE_QA_RETIRED", plan } });
      const retirement = (await admin.query("select operator_session,operator_role,audit_reference,plan from crm_studio_source_qa_retirements where operation_id=$1", [first])).rows[0];
      assert.deepEqual(retirement, { operator_session: "neondb_owner", operator_role: "neondb_owner", audit_reference: auditReference, plan });
      for (const sql of [
        "update crm_studio_source_qa_retirements set retired_at=clock_timestamp()",
        "delete from crm_studio_source_qa_retirements", "truncate crm_studio_source_qa_retirements",
        "update audit_logs set action='modified'", "delete from audit_logs", "truncate audit_logs",
      ]) await assert.rejects(admin.query(sql), /immutable|append-only/);
      assert.deepEqual(await originals(), beforeOriginals, "retirement never rewrites original intake, source sequence or activation");
      await assert.rejects(admin.query("update studio_enquiry_transfers set snapshot_text=snapshot_text where operation_id=$1", [first]),
        /Studio confirmation is immutable/, "the unchanged original 100 guard still protects the accepted transfer");
      assert.deepEqual((await admin.query("select to_jsonb(a) as original from audit_logs a where id=$1", [staleAuditReference])).rows[0].original,
        priorAudit, "the rejected prior audit is retained byte-for-field, never deleted or rewritten");
      const probeSecret = Buffer.alloc(32, 3).toString("base64url"), probe = await grant("dpl_New", probeSecret);
      const normal = await readStudioSource(request(jwt, { cursor: null, limit: 1 }, host, probeSecret), { pool, env: probe.env, verifier, now });
      assert.equal(normal.status, 200);
      const normalPage = await normal.json();
      assert.deepEqual(normalPage.events, two.events, "retired first event is excluded before ORDER/LIMIT so unmarked second remains readable");
      assert.equal(normalPage.nextCursor, two.nextCursor, "sealed sequence positions do not change after append-only retirement");
      assert.equal(normalPage.hasMore, false);
      const cursorRetry = await readStudioSource(request(jwt, { cursor: one.nextCursor, limit: 1 }, host, probeSecret), { pool, env: probe.env, verifier, now });
      const retried = await cursorRetry.json();
      assert.deepEqual(retried.events, two.events);
      assert.equal(retried.nextCursor, two.nextCursor);
      const savedCursor = two.nextCursor;
      const emptyInput = { cursor: savedCursor, limit: 1 };
      const exhausted = await readStudioSource(request(jwt, emptyInput, host, probeSecret), { pool, env: probe.env, verifier, now });
      assert.equal(exhausted.status, 200);
      const exhaustedPage = await exhausted.json();
      assert.deepEqual({ events: exhaustedPage.events, nextCursor: exhaustedPage.nextCursor, hasMore: exhaustedPage.hasMore },
        { events: [], nextCursor: null, hasMore: false });
      assert.deepEqual(emptyInput, { cursor: savedCursor, limit: 1 });
      assert.equal(two.nextCursor, savedCursor, "an empty page does not erase or mutate the caller's previously saved cursor");
      const readerTx = await runtimeConnection.connect();
      try {
        // The Sales verifier locks its grant inside the normal command transaction.
        await readerTx.query("begin");
        await readerTx.query("set local role novalure_tenant_app");
        await readerTx.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",
          [websiteSalesWorkspaceId, "6122a6da-e7f4-47fa-bc55-e296bb01af62"]);
        const matches = async (tuple: typeof plan.tuple) => (await readerTx.query(`select
          public.crm_studio_preview_source_transfer_matches($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::integer,$8,$9::uuid,$10::uuid) as matched`,
          [probe.id, probe.env.VERCEL_DEPLOYMENT_ID, probe.env.VERCEL_GIT_COMMIT_SHA, tuple.workspaceId, tuple.crmProjectId,
            tuple.operationId, tuple.revision, tuple.payloadHash, tuple.leadId, tuple.submissionId])).rows[0].matched;
        assert.equal(await matches(plan.tuple), false, "the Sales Preview matcher rejects the retired exact receipt");
        assert.equal(await matches(await tupleFor(second)), true, "the normal unretired receipt remains eligible");
        await assert.rejects(readerTx.query("select public.crm_studio_preview_source_transfer_matches_before_qa_retirement($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::integer,$8,$9::uuid,$10::uuid)",
          [probe.id, probe.env.VERCEL_DEPLOYMENT_ID, probe.env.VERCEL_GIT_COMMIT_SHA, plan.tuple.workspaceId, plan.tuple.crmProjectId,
            plan.tuple.operationId, plan.tuple.revision, plan.tuple.payloadHash, plan.tuple.leadId, plan.tuple.submissionId]), /permission denied/,
        "runtime cannot bypass retirement through the preserved owner-only matcher");
      } finally { await readerTx.query("rollback"); readerTx.release(); }
      const beforeReinstall = (await admin.query("select oid,proname from pg_proc where proname like 'crm_studio_preview_source_transfer_matches%' order by proname")).rows;
      await owner.query("begin");
      try {
        await owner.query("set local role studio_source_fixture_owner");
        await assert.rejects(owner.query(await readFile("migrations/staged/evelyn_studio_source_qa_retirement.sql", "utf8")),
          /STUDIO_QA_RETIREMENT_INSTALLER_BOUNDARY/, "reapplying the additive stage cannot rename or wrap the matcher again");
      } finally { await owner.query("rollback"); }
      assert.deepEqual((await admin.query("select oid,proname from pg_proc where proname like 'crm_studio_preview_source_transfer_matches%' order by proname")).rows,
        beforeReinstall);
      assert.deepEqual(await counts(), { retirements: 1, audits: 2 });
    });
  } finally { owner.release(); }
});
}
