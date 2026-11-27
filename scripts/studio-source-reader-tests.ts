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

test("native staged SOURCE preserves activation and sealed progress through ordered commits and grant rotation", async t => {
  const cluster = await startLocalSalesDb();
  const local = { host: "127.0.0.1", port: cluster.port, database: "neondb" };
  const runtimeConnection = new LocalSalesPool({ ...local, user: "novalure_app" });
  let adminConnection: LocalSalesPool | undefined;
  const previous = process.env.DATABASE_URL;
  t.after(async () => {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    try { await Promise.all([adminConnection?.end(), runtimeConnection?.end()]); }
    finally { await cluster.stop(); }
  });
  process.env.DATABASE_URL = `postgresql://novalure_app@127.0.0.1:${cluster.port}/neondb`;
  await cluster.admin.query("create database neondb");
  await cluster.admin.query(`
    alter database neondb set neon.project_id = 'misty-cloud-70835427';
    alter database neondb set neon.branch_id = 'br-spring-night-alyu48yp';
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
    create table leads(id uuid, workspace_id uuid, project_id uuid);
    create table form_submissions(id uuid, workspace_id uuid, project_id uuid, lead_id uuid, form_id uuid, mode text,
      deal_id uuid, contact_id uuid);
    create table studio_enquiry_transfers(operation_id uuid primary key, workspace_id uuid, revision integer, payload_hash text,
      snapshot_text text, state text, lead_id uuid, submission_id uuid, accepted_at timestamptz);
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
  await admin.query("insert into workspace_users values ('6122a6da-e7f4-47fa-bc55-e296bb01af62',$1,'active','agent','novalure_operator')", [websiteSalesWorkspaceId]);
  await admin.query("insert into forms values ($1,$2,$3,'aktiv')", [websiteSalesFormId, websiteSalesWorkspaceId, studioEnquiryCrmProject]);
  const add = async (syntheticTest: boolean) => {
    const item = { id: randomUUID(), lead: randomUUID(), submission: randomUUID() };
    await admin.query("insert into leads values ($1,$2,$3)", [item.lead, websiteSalesWorkspaceId, studioEnquiryCrmProject]);
    await admin.query("insert into form_submissions values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [item.submission, websiteSalesWorkspaceId, studioEnquiryCrmProject, item.lead, websiteSalesFormId,
        syntheticTest ? "test" : "live", randomUUID(), randomUUID()]);
    await admin.query("insert into studio_enquiry_transfers values ($1,$2,1,$3,$4,'reserved',$5,$6,null)",
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
      activation = owner.query("insert into crm_studio_source_activation(profile) values ('production') returning starts_after");
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
    const first = await add(false), second = await add(false);
    await accept(first, "2026-11-27T12:00:01.009999Z");
    await accept(await add(true));
    await accept(second, "2026-11-27T12:00:00.001111Z"); // Earlier timestamp, later commit.
    await add(false); // Still reserved.
    const grant = async (deploy: string, credential: string) => {
      const env = runtime("production", deploy), id = randomUUID();
      await owner.query(`insert into crm_studio_source_grants
        (id,profile,workload_id,workspace_id,crm_project_id,receiver_project,deployment_id,revision,credential_hash,authority_reference,expires_at)
        values ($1,'production',$2,$3,$4,$5,$6,$7,$8,'synthetic exact grant',clock_timestamp()+interval '1 hour')`,
      [id, workload, websiteSalesWorkspaceId, studioEnquiryCrmProject, studioEnquiryProject, deploy, env.VERCEL_GIT_COMMIT_SHA,
        createHash("sha256").update(credential, "ascii").digest("hex")]);
      return { env, id };
    };
    const old = await grant("dpl_Old", sourceSecret);
    const jwt = await token("production");
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
    const paired = await loadPairedStudioReader();
    if (paired) {
      const origin = "https://www.novalure-crm.app";
      let reads = 0;
      const read = paired.createCrmStudioSourceReader({
        origin, deploymentId: next.env.VERCEL_DEPLOYMENT_ID, crmRevision: next.env.VERCEL_GIT_COMMIT_SHA,
        sourceGrantId: next.id, profile: "production", readGrantCredential: async () => rotated,
        getToken: async audience => { assert.equal(audience, CRM_MACHINE_AUDIENCE); return jwt; },
        fetch: async (input, init) => {
          assert.equal(++reads, 1);
          assert.equal(String(input), `${origin}${studioSourcePath}`);
          const inbound = new Request(input, init);
          assert.deepEqual(await inbound.clone().json(), { cursor: one.nextCursor, limit: 1 });
          const response = await readStudioSource(inbound, { pool, env: next.env, verifier, now });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.clone().json(), two);
          return response;
        },
      });
      assert.deepEqual(await read(one.nextCursor), {
        crmRevision: next.env.VERCEL_GIT_COMMIT_SHA, crmDeploymentId: next.env.VERCEL_DEPLOYMENT_ID,
        transfer: two.events[0], nextCursor: two.nextCursor,
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
  } finally { owner.release(); }
});
