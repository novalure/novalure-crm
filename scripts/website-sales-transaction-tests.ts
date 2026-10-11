import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { closeLocalTestPool, getLocalTestPool } from "../src/lib/db/local-test-transport";
import type { PoolClient } from "@neondatabase/serverless";
import { PublicSubmissionTransactionError, withPublicSubmissionTransaction } from "../src/lib/db/client";
import { getPublicWebsiteFormByKey, persistWebsiteFormSubmission } from "../src/lib/db/form-repositories";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
} from "../src/lib/db/public-submission-abuse-repository";
import { createPublicSubmissionIdempotencyHashes, buildPublicSubmissionScope, createPublicSubmissionProof, publicSubmissionControlFields, publicSubmissionActions } from "../src/lib/security/public-submission-abuse";
import { websiteSalesActorId, websiteSalesFormId, websiteSalesWorkspaceId } from "../src/lib/website-sales-ingestion";
import { buildWebsiteSalesSignature, websiteSalesContractVersion } from "../src/lib/website-sales-ingestion";
import { POST as ingestWebsiteSales } from "../src/app/api/public/website-sales/route";
import { POST as submitGenericForm } from "../src/app/api/forms/submissions/route";
import { GET as renderGenericEmbed } from "../src/app/forms/embed/route";
import { isBusinessKpiRecord, businessKpiSqlPredicate } from "../src/lib/website-sales-kpi";

const projectId = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";
const actorId = websiteSalesActorId;
const genericFormId = "829f4222-af69-4b9b-8fe7-4e0141665c5c";
const genericActorId = "b20270d1-3b4e-4964-8e6b-27413a9b5265";
let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const savedEnv = {
  CRM_LOCAL_TEST_DATABASE: process.env.CRM_LOCAL_TEST_DATABASE,
  DATABASE_URL: process.env.DATABASE_URL,
  NOVALURE_ABUSE_SECRET: process.env.NOVALURE_ABUSE_SECRET,
  NOVALURE_STUDIO_INGESTION_SECRET: process.env.NOVALURE_STUDIO_INGESTION_SECRET,
  NOVALURE_TRUSTED_CLIENT_IP_HEADER: process.env.NOVALURE_TRUSTED_CLIENT_IP_HEADER,
  NODE_ENV: process.env.NODE_ENV,
};

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { includeD11Contract: false, maxMigrationNumber: 90 });
  // The isolated sales fixture omits legacy public-form grants present in Production.
  await db.admin.query("grant select, insert, update on forms, form_submissions, tasks, consent_records, contact_timeline_items, analytics_events, speed_to_lead_events to novalure_app; grant select on funnels to novalure_app");
  await db.admin.query(
    "insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Website Sales','novalure_internal') on conflict(id) do nothing",
    [websiteSalesWorkspaceId],
  );
  await db.admin.query("update workspaces set public_key='synthetic-website-sales' where id=$1", [websiteSalesWorkspaceId]);
  // Recreate only the pre-existing, approved internal operator for this isolated fixture.
  // Production already has this membership from migrations 092 and 093.
  await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC: Evelyn CRM service actor','evelyn-crm-service@service.invalid','agent','novalure_operator','active')",
    [actorId, websiteSalesWorkspaceId],
  );
  await db.admin.query(
    "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Website Sales','Bauträger') on conflict(id) do nothing",
    [projectId, websiteSalesWorkspaceId],
  );
  const migration = await readFile(new URL("../migrations/094_website_sales_ingestion.sql", import.meta.url), "utf8");
  const guardClient = await db.admin.connect();
  try {
    await guardClient.query("begin");
    await guardClient.query("update workspace_users set status='suspended' where id=$1", [actorId]);
    await assert.rejects(guardClient.query(migration), /existing active internal operator actor/);
    await guardClient.query("rollback");
  } finally {
    guardClient.release();
  }
  await db.admin.query(migration);
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum)
     values('094_website_sales_ingestion','094_website_sales_ingestion.sql','synthetic-prerequisite')`,
  );
  await db.admin.query(await readFile(new URL("../migrations/095_form_tenant_isolation.sql", import.meta.url), "utf8"));
  const membershipCount = await db.admin.query<{ count: string }>(
    "select count(*)::text as count from workspace_users where workspace_id=$1",
    [websiteSalesWorkspaceId],
  );
  assert.equal(membershipCount.rows[0].count, "1", "migration 094 must not add a workspace membership");
  await db.admin.query(
    `insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
     values($1,$2,'SYNTHETIC public form operator','public-form-operator@example.invalid','owner','novalure_operator','active')`,
    [genericActorId, websiteSalesWorkspaceId],
  );
  await db.admin.query(
    `insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
     values($1,$2,$3,$4,'SYNTHETIC public form','generic-public','aktiv',
       '[{"id":"name","crmField":"name","label":"Name","type":"text","required":true},{"id":"email","crmField":"email","label":"Email","type":"email","required":true},{"id":"privacy","crmField":"privacy","label":"Privacy","type":"consent","required":true}]'::jsonb,
       '{"createTask":true}'::jsonb)`,
    [genericFormId, websiteSalesWorkspaceId, projectId, genericActorId],
  );
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.CRM_LOCAL_TEST_DATABASE = "1";
  process.env.DATABASE_URL = `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
  process.env.NOVALURE_ABUSE_SECRET = "synthetic-website-sales-abuse-secret-for-local-tests";
  process.env.NOVALURE_STUDIO_INGESTION_SECRET = "synthetic-website-sales-signing-secret-for-local-tests";
  process.env.NOVALURE_TRUSTED_CLIENT_IP_HEADER = "x-test-client-ip";
});

after(async () => {
  await closeLocalTestPool();
  if (db) await db.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
});

function formData(email = "website-sales-lead@example.invalid") {
  const form = new FormData();
  form.set("name", "SYNTHETIC Website Sales");
  form.set("email", email);
  form.set("company", "SYNTHETIC Test Company");
  form.set("package_interest", "BUSINESS");
  form.set("message", "SYNTHETIC consultation request");
  form.set("privacy", "true");
  form.set("synthetic_test", "true");
  return form;
}

async function counts() {
  const result: Record<string, number> = {};
  for (const relation of ["contacts", "leads", "deals", "tasks", "form_submissions"]) {
    const row = await db.admin.query<{ count: string }>(`select count(*)::text as count from ${relation} where workspace_id=$1`, [websiteSalesWorkspaceId]);
    result[relation] = Number(row.rows[0].count);
  }
  return result;
}

test("a post-write failure rolls back all CRM records and permits one same-key replay", { timeout: 240_000 }, async () => {
  const hashes = createPublicSubmissionIdempotencyHashes({
    action: "website_form",
    idempotencyKey: randomUUID(),
    requestFingerprint: "a".repeat(64),
    scope: buildPublicSubmissionScope({ resourceId: websiteSalesFormId, resourceType: "form", workspaceId: websiteSalesWorkspaceId }),
  });
  await assert.rejects(
    withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => {
      assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "claimed" });
      const persisted = await persistWebsiteFormSubmission({ actorUserId: actorId, formData: formData(), formKey: websiteSalesFormId, requestUrl: "https://novalurestudio.ie/" });
      assert.equal(persisted.persisted, true);
      throw new Error("SYNTHETIC fault after Contact/Lead/Deal/Task writes");
    }),
    (error: unknown) => error instanceof PublicSubmissionTransactionError && error.rollbackConfirmed,
  );
  assert.deepEqual(await counts(), { contacts: 0, leads: 0, deals: 0, tasks: 0, form_submissions: 0 });
  const snapshot = { body: { accepted: true, reference: "SYNTHETIC-REPLAY" }, kind: "json" as const, status: 202 };
  await withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => {
    assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "claimed" });
    const persisted = await persistWebsiteFormSubmission({ actorUserId: actorId, formData: formData(), formKey: websiteSalesFormId, requestUrl: "https://novalurestudio.ie/" });
    assert.equal(persisted.persisted, true);
    await completePublicSubmissionIdempotency({ idempotencyHash: hashes.idempotencyHash, requestHash: hashes.requestHash, response: snapshot });
  });
  assert.deepEqual(await counts(), { contacts: 1, leads: 1, deals: 1, tasks: 1, form_submissions: 1 });
  assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "replay", response: snapshot });
  assert.deepEqual(await counts(), { contacts: 1, leads: 1, deals: 1, tasks: 1, form_submissions: 1 });
});

test("an ambiguous commit keeps the key guarded and replays its durable success receipt", { timeout: 240_000 }, async () => {
  const hashes = createPublicSubmissionIdempotencyHashes({
    action: "website_form",
    idempotencyKey: randomUUID(),
    requestFingerprint: "b".repeat(64),
    scope: buildPublicSubmissionScope({ resourceId: websiteSalesFormId, resourceType: "form", workspaceId: websiteSalesWorkspaceId }),
  });
  const before = await counts();
  const local = await getLocalTestPool(process.env.DATABASE_URL!);
  assert.ok(local);
  const lostCommitAckPool = {
    async connect() {
      const client = await local.connect();
      return {
        async query(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params);
          if (sql === "commit") throw new Error("SYNTHETIC lost COMMIT acknowledgement");
          return result;
        },
        release() { client.release(); },
      } as unknown as PoolClient;
    },
  };
  const snapshot = { body: { accepted: true, reference: "SYNTHETIC-COMMITTED" }, kind: "json" as const, status: 202 };
  await assert.rejects(
    withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => {
      assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "claimed" });
      const persisted = await persistWebsiteFormSubmission({ actorUserId: actorId, formData: formData("website-sales-ambiguous@example.invalid"), formKey: websiteSalesFormId, requestUrl: "https://novalurestudio.ie/" });
      assert.equal(persisted.persisted, true);
      await completePublicSubmissionIdempotency({ idempotencyHash: hashes.idempotencyHash, requestHash: hashes.requestHash, response: snapshot });
    }, { pool: lostCommitAckPool }),
    (error: unknown) => error instanceof PublicSubmissionTransactionError && !error.rollbackConfirmed,
  );
  assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "replay", response: snapshot });
  const after = await counts();
  for (const relation of ["contacts", "leads", "deals", "tasks", "form_submissions"]) {
    assert.equal(after[relation], before[relation] + 1, `${relation} was inserted once`);
  }
  const audit = await db.admin.query<{ actorUserId: string; ingestionSource: string }>(
    `select actor_user_id as "actorUserId", after->>'ingestionSource' as "ingestionSource"
     from audit_logs where workspace_id=$1 and action='form.submission.persisted'
     order by created_at desc limit 1`,
    [websiteSalesWorkspaceId],
  );
  assert.equal(audit.rows[0]?.actorUserId, actorId);
  assert.equal(audit.rows[0]?.ingestionSource, "NOVALURE_STUDIO_SIGNED_WEBSITE_SALES");
  assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "replay", response: snapshot });
  assert.deepEqual(await counts(), after);
});

test("signed HTTP ingestion returns the same success receipt with one set of CRM records", { timeout: 240_000 }, async () => {
  const before = await counts();
  const body = JSON.stringify({
    company: "SYNTHETIC HTTP Company",
    consent: true,
    email: "website-sales-http@example.invalid",
    idempotencyKey: randomUUID(),
    message: "SYNTHETIC website consultation",
    name: "SYNTHETIC HTTP Buyer",
    packageInterest: "BUSINESS",
    syntheticTest: true,
    version: websiteSalesContractVersion,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildWebsiteSalesSignature({ body, secret: process.env.NOVALURE_STUDIO_INGESTION_SECRET!, timestamp });
  const submit = () => ingestWebsiteSales(new Request("https://crm.example.invalid/api/public/website-sales", {
    body,
    headers: {
      "content-type": "application/json",
      "x-novalure-client-ip": "203.0.113.10",
      "x-novalure-signature": signature,
      "x-novalure-timestamp": timestamp,
    },
    method: "POST",
  }));
  const first = await submit();
  assert.equal(first.status, 202);
  const receipt = await first.json();
  const second = await submit();
  assert.equal(second.status, 202);
  assert.deepEqual(await second.json(), receipt);
  const after = await counts();
  for (const relation of ["contacts", "leads", "deals", "tasks", "form_submissions"]) {
    assert.equal(after[relation], before[relation] + 1, `${relation} was inserted once`);
  }
});

test("public submission transactions reject an invalid scope or privileged role before business writes", async () => {
  let called = false;
  await assert.rejects(
    withPublicSubmissionTransaction({ actorId, workspaceId: "invalid" }, async () => { called = true; }),
    (error: unknown) => error instanceof PublicSubmissionTransactionError && error.rollbackConfirmed,
  );
  await assert.rejects(
    withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => { called = true; }, {
      pool: { connect: async () => await db.admin.connect() as unknown as PoolClient },
    }),
    (error: unknown) => error instanceof PublicSubmissionTransactionError && error.rollbackConfirmed,
  );
  assert.equal(called, false);
});

test("dedicated Website Sales form cannot be submitted or exposed through generic public forms", async () => {
  const before = await counts();
  assert.equal(await getPublicWebsiteFormByKey(websiteSalesFormId), null);
  assert.ok(await withPublicSubmissionTransaction(
    { actorId, workspaceId: websiteSalesWorkspaceId },
    () => getPublicWebsiteFormByKey(websiteSalesFormId, { includeSignedWebsiteSales: true }),
  ));
  const canonicalKey = "synthetic-website-sales/novalure-studio-website-sales-v1";
  assert.equal(await getPublicWebsiteFormByKey(canonicalKey), null);
  assert.ok(await withPublicSubmissionTransaction(
    { actorId, workspaceId: websiteSalesWorkspaceId },
    () => getPublicWebsiteFormByKey(canonicalKey, { includeSignedWebsiteSales: true }),
  ));

  const genericData = formData("website-sales-generic-bypass@example.invalid");
  genericData.set("form_id", websiteSalesFormId);
  const genericResponse = await submitGenericForm(new Request("https://crm.example.invalid/api/forms/submissions", {
    body: genericData,
    headers: { accept: "application/json" },
    method: "POST",
  }));
  assert.equal(genericResponse.status, 404);
  genericData.set("form_slug", canonicalKey);
  const canonicalResponse = await submitGenericForm(new Request("https://crm.example.invalid/api/forms/submissions", {
    body: genericData,
    headers: { accept: "application/json" },
    method: "POST",
  }));
  assert.equal(canonicalResponse.status, 404);
  const directPersistence = await persistWebsiteFormSubmission({
    formData: genericData,
    formKey: websiteSalesFormId,
    requestUrl: "https://crm.example.invalid/forms/embed",
  });
  assert.deepEqual(directPersistence, { persisted: false, reason: "Form not found" });

  const embedResponse = await renderGenericEmbed(new Request(`https://crm.example.invalid/forms/embed?form=${websiteSalesFormId}`));
  const embed = await embedResponse.text();
  assert.equal(embedResponse.status, 200);
  assert.doesNotMatch(embed, /submissionProof|public_submission_proof|api\/forms\/submissions/);
  assert.deepEqual(await counts(), before);
});

test("synthetic records are visible in operational storage but excluded by KPI predicates", async () => {
  const rows = await db.admin.query<{ synthetic: boolean }>(
    `select ${businessKpiSqlPredicate} as synthetic from leads where workspace_id=$1`,
    [websiteSalesWorkspaceId],
  );
  assert.equal(rows.rows.length, 3);
  assert.ok(rows.rows.every((row) => row.synthetic === false));
  const submissions = await db.admin.query<{ mode: string }>("select mode from form_submissions where form_id=$1", [websiteSalesFormId]);
  assert.equal(submissions.rows.length, 3);
  assert.ok(submissions.rows.every((row) => row.mode === "test"));
  const form = await db.admin.query<{ submissions_count: number }>("select submissions_count from forms where id=$1", [websiteSalesFormId]);
  assert.equal(form.rows[0].submissions_count, 0);
  assert.equal(isBusinessKpiRecord({ syntheticTest: true }), false);
  assert.equal(isBusinessKpiRecord({ syntheticTest: false }), true);
  assert.equal(isBusinessKpiRecord({}), true);
});

test("anonymous public form submits through the server transaction without table access", async () => {
  const publicKey = "synthetic-website-sales/generic-public";
  const lookup = await getPublicWebsiteFormByKey(publicKey);
  assert.equal(lookup?.id, genericFormId);
  assert.equal(lookup?.publicActorId, genericActorId);
  const data = new FormData();
  data.set("form_slug", publicKey);
  data.set("name", "SYNTHETIC public contact");
  data.set("email", "generic-public@example.invalid");
  data.set("privacy", "true");
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    scope: buildPublicSubmissionScope({ resourceId: genericFormId, resourceType: "form", workspaceId: websiteSalesWorkspaceId }),
  });
  data.set(publicSubmissionControlFields.idempotencyKey, proof.idempotencyKey);
  data.set(publicSubmissionControlFields.issuedAt, String(proof.issuedAt));
  data.set(publicSubmissionControlFields.expiresAt, String(proof.expiresAt));
  data.set(publicSubmissionControlFields.proof, proof.signature);
  data.set(publicSubmissionControlFields.honeypot, "");
  const response = await submitGenericForm(new Request("https://crm.example.invalid/api/forms/submissions", {
    body: data,
    headers: { accept: "application/json", "x-test-client-ip": "192.0.2.10" },
    method: "POST",
  }));
  if (response.status !== 200) assert.fail(await response.text());
  const body = await response.json() as { form: { ownerUserId: string; pipelineStage: string; actions: { createTask: boolean } } };
  assert.equal(body.form.ownerUserId, "");
  assert.equal(body.form.pipelineStage, "");
  assert.equal(body.form.actions.createTask, false);
  const row = await db.admin.query<{ workspace_id: string; mode: string }>(
    "select workspace_id,mode from form_submissions where form_id=$1",
    [genericFormId],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].workspace_id, websiteSalesWorkspaceId);
  data.set("workspaceId", "00000000-0000-4000-8000-000000000001");
  const forged = await submitGenericForm(new Request("https://crm.example.invalid/api/forms/submissions", {
    body: data,
    headers: { accept: "application/json", "x-test-client-ip": "192.0.2.10" },
    method: "POST",
  }));
  assert.equal(forged.status, 400);
  assert.equal((await db.admin.query("select id from form_submissions where form_id=$1", [genericFormId])).rowCount, 1);
});
