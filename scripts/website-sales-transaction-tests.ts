import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import { closeLocalTestPool, getLocalTestPool } from "../src/lib/db/local-test-transport";
import type { PoolClient } from "@neondatabase/serverless";
import { PublicSubmissionTransactionError, queryRows, withPublicSubmissionTransaction } from "../src/lib/db/client";
import { getPublicWebsiteFormByKey, listWebsiteForms, persistWebsiteFormSubmission, upsertWebsiteForm } from "../src/lib/db/form-repositories";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import { getSessionFromHeaders } from "../src/lib/auth/session";
import {
  claimPublicSubmissionIdempotency,
  completePublicSubmissionIdempotency,
  consumePublicSubmissionRateLimits,
  readCompletedPublicSubmissionIdempotency,
} from "../src/lib/db/public-submission-abuse-repository";
import { createPublicSubmissionIdempotencyHashes, buildPublicSubmissionScope, createPublicSubmissionProof, publicSubmissionControlFields, publicSubmissionActions } from "../src/lib/security/public-submission-abuse";
import { websiteSalesActorId, websiteSalesFormId, websiteSalesWorkspaceId } from "../src/lib/website-sales-ingestion";
import { buildWebsiteSalesSignature, websiteSalesContractVersion } from "../src/lib/website-sales-ingestion";
import { POST as ingestWebsiteSales } from "../src/app/api/public/website-sales/route";
import { POST as studioBookingPost } from "../src/app/api/public/website-sales/booking/route";
import { availableStudioSlots } from "../src/lib/studio-sales-booking";
import type { StudioCalendarPolicy } from "../src/lib/integrations/studio-microsoft-calendar";
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
  STUDIO_BOOKING_REAL_MODE: process.env.STUDIO_BOOKING_REAL_MODE,
  STUDIO_BOOKING_POLICY_JSON: process.env.STUDIO_BOOKING_POLICY_JSON,
  STUDIO_BOOKING_CONFIG_APPROVAL_ID: process.env.STUDIO_BOOKING_CONFIG_APPROVAL_ID,
  STUDIO_BOOKING_PUBLIC_ID: process.env.STUDIO_BOOKING_PUBLIC_ID,
  MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_CALENDAR_USER_ID: process.env.MICROSOFT_CALENDAR_USER_ID,
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
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum)
     values('095_form_tenant_isolation','095_form_tenant_isolation.sql','synthetic-prerequisite')`,
  );
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
  await db.admin.query(await readFile(new URL("../migrations/096_public_integration_gateway.sql", import.meta.url), "utf8"));
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum)
     values('096_public_integration_gateway','096_public_integration_gateway.sql','synthetic-prerequisite')`,
  );
  await db.admin.query(await readFile(new URL("../migrations/097_studio_sales_calendar_bridge.sql", import.meta.url), "utf8"));
  await db.admin.query(
    `insert into novalure_schema_migrations(version,name,checksum)
     values('097_studio_sales_calendar_bridge','097_studio_sales_calendar_bridge.sql','synthetic-prerequisite')`,
  );
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.CRM_LOCAL_TEST_DATABASE = "1";
  process.env.DATABASE_URL = `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`;
  process.env.NOVALURE_ABUSE_SECRET = "synthetic-website-sales-abuse-secret-for-local-tests";
  process.env.NOVALURE_STUDIO_INGESTION_SECRET = "synthetic-website-sales-signing-secret-for-local-tests";
  process.env.NOVALURE_TRUSTED_CLIENT_IP_HEADER = "x-test-client-ip";
  // This predecessor fixture has no published common-channel Studio scope.
  delete process.env.STUDIO_BOOKING_PUBLIC_ID;
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
  assert.deepEqual(await readCompletedPublicSubmissionIdempotency(hashes), snapshot);
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

test("a failed COMMIT before execution leaves no receipt and permits a normal retry", { timeout: 240_000 }, async () => {
  const hashes = createPublicSubmissionIdempotencyHashes({
    action: "website_form",
    idempotencyKey: randomUUID(),
    requestFingerprint: "c".repeat(64),
    scope: buildPublicSubmissionScope({ resourceId: websiteSalesFormId, resourceType: "form", workspaceId: websiteSalesWorkspaceId }),
  });
  const local = await getLocalTestPool(process.env.DATABASE_URL!);
  assert.ok(local);
  const failedCommitPool = {
    async connect() {
      const client = await local.connect();
      return {
        async query(sql: string, params?: unknown[]) {
          if (sql === "commit") throw new Error("SYNTHETIC COMMIT never reached database");
          return client.query(sql, params);
        },
        release() { client.release(); },
      } as unknown as PoolClient;
    },
  };
  await assert.rejects(
    withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => {
      assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "claimed" });
    }, { pool: failedCommitPool }),
    (error: unknown) => error instanceof PublicSubmissionTransactionError && !error.rollbackConfirmed,
  );
  assert.equal(await readCompletedPublicSubmissionIdempotency(hashes), null);
  assert.equal((await db.admin.query("select idempotency_hash from public_submission_idempotency where idempotency_hash=$1", [hashes.idempotencyHash])).rowCount, 0);
  await withPublicSubmissionTransaction({ actorId, workspaceId: websiteSalesWorkspaceId }, async () => {
    assert.deepEqual(await claimPublicSubmissionIdempotency(hashes), { state: "claimed" });
  });
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
  const submit = (statusOnly = false) => ingestWebsiteSales(new Request("https://crm.example.invalid/api/public/website-sales", {
    body,
    headers: {
      "content-type": "application/json",
      "x-novalure-client-ip": "203.0.113.10",
      "x-novalure-signature": signature,
      "x-novalure-timestamp": timestamp,
      ...(statusOnly ? { "x-novalure-status-only": "1" } : {}),
    },
    method: "POST",
  }));
  const first = await submit();
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.match(receipt.crmLeadId, /^[0-9a-f-]{36}$/);
  const second = await submit();
  assert.equal(second.status, 202);
  assert.deepEqual(await second.json(), receipt);
  const status = await submit(true);
  assert.equal(status.status, 202);
  assert.deepEqual(await status.json(), receipt);
  const durable = await db.admin.query(
    "select lead_id, submission_id from studio_sales_handoffs where reference=$1", [receipt.reference],
  );
  assert.equal(durable.rows.length, 1);
  assert.equal(durable.rows[0].lead_id, receipt.crmLeadId);
  const after = await counts();
  for (const relation of ["contacts", "leads", "deals", "tasks", "form_submissions"]) {
    assert.equal(after[relation], before[relation] + 1, `${relation} was inserted once`);
  }
});

test("Studio booking persists the lead link, deduplicates creation and reconciles a provider timeout", { timeout: 240_000 }, async () => {
  const secret = process.env.NOVALURE_STUDIO_INGESTION_SECRET!;
  const leadBody = JSON.stringify({ company: "SYNTHETIC Studio Booking", consent: true,
    email: "studio-booking@example.invalid", idempotencyKey: randomUUID(),
    message: "SYNTHETIC website booking consultation", name: "SYNTHETIC Buyer",
    packageInterest: "UNDECIDED", syntheticTest: true, version: websiteSalesContractVersion });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const leadSignature = buildWebsiteSalesSignature({ body: leadBody, secret, timestamp });
  const lead = await ingestWebsiteSales(new Request("https://crm.example.invalid/api/public/website-sales", {
    method: "POST", body: leadBody, headers: { "content-type": "application/json",
      "x-novalure-client-ip": "203.0.113.10", "x-novalure-signature": leadSignature,
      "x-novalure-timestamp": timestamp },
  }));
  assert.equal(lead.status, 202);
  const leadReceipt = await lead.json();
  const policy: StudioCalendarPolicy = { approvalId: "SYNTHETIC-QA-2026",
    organizerId: "synthetic-franz@example.invalid", calendarId: "synthetic-calendar-id",
    timeZone: "UTC", durationMinutes: 30, intervalMinutes: 30, minNoticeMinutes: 0,
    bufferMinutes: 15, horizonDays: 2,
    hours: Object.fromEntries(Array.from({ length: 7 }, (_, day) =>
      [String(day), [{ start: 0, end: 1440 }]])) };
  Object.assign(process.env, { STUDIO_BOOKING_REAL_MODE: "1",
    STUDIO_BOOKING_POLICY_JSON: JSON.stringify(policy),
    STUDIO_BOOKING_CONFIG_APPROVAL_ID: policy.approvalId,
    MICROSOFT_TENANT_ID: "synthetic-tenant", MICROSOFT_CLIENT_ID: "synthetic-client",
    MICROSOFT_CLIENT_SECRET: "synthetic-secret", MICROSOFT_CALENDAR_USER_ID: policy.organizerId });
  const originalFetch = global.fetch;
  const events: Array<{ id: string; transactionId: string; start: { dateTime: string };
    end: { dateTime: string }; showAs: string; onlineMeeting: { joinUrl: string } }> = [];
  let creates = 0;
  let timeoutAfterCreate = false;
  let denyGraph = false;
  const createdPayloads: Array<Record<string, unknown>> = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://login.microsoftonline.com/")) {
      if (denyGraph) return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
      return new Response(JSON.stringify({ access_token: "SYNTHETIC-TOKEN" }), { status: 200 });
    }
    if (target.includes("/calendarView")) {
      return new Response(JSON.stringify({ value: events }), { status: 200 });
    }
    if (target.endsWith("/events") && options.method === "POST") {
      creates += 1;
      const payload = JSON.parse(String(options.body));
      createdPayloads.push(payload);
      events.push({ id: `SYNTHETIC-GRAPH-${creates}`, transactionId: payload.transactionId,
        start: payload.start, end: payload.end, showAs: "busy",
        onlineMeeting: { joinUrl: payload.isOnlineMeeting
          ? "https://teams.microsoft.com/l/meetup-join/synthetic" : "" } });
      if (timeoutAfterCreate) throw new Error("SYNTHETIC timeout after provider creation");
      return new Response(JSON.stringify(events.at(-1)), { status: 201 });
    }
    throw new Error("Unexpected synthetic provider request");
  };
  const signedBooking = async (body: Record<string, unknown>, badSignature = false) => {
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", secret)
      .update(`website-sales-booking-v1.${timestamp}.${raw}`).digest("base64url");
    return studioBookingPost(new Request("https://crm.example.invalid/api/public/website-sales/booking", {
      method: "POST", body: raw, headers: { "content-type": "application/json",
        "x-novalure-signature": badSignature ? "invalid" : signature,
        "x-novalure-timestamp": timestamp },
    }));
  };
  try {
    assert.equal((await signedBooking({ operation: "availability", kind: "teams",
      visitorTimeZone: "UTC" }, true)).status, 401);
    const availability = await signedBooking({ operation: "availability", kind: "teams",
      visitorTimeZone: "UTC" });
    assert.equal(availability.status, 200);
    const slots = (await availability.json()).slots as Array<{ start: string }>;
    assert.ok(slots.length >= 2);
    const booking = { confirmed: true, idempotencyKey: randomUUID(),
      crmReference: leadReceipt.reference, kind: "teams", visitorTimeZone: "UTC",
      start: slots[0].start, name: "SYNTHETIC Buyer", email: "studio-booking@example.invalid",
      phone: "", reason: "SYNTHETIC website consultation" };
    assert.equal((await signedBooking({ operation: "book", booking: { ...booking,
      crmReference: "NL-00000000" } })).status, 503);
    const first = await signedBooking({ operation: "book", booking });
    assert.equal(first.status, 200);
    const receipt = await first.json();
    assert.equal(receipt.status, "booked");
    assert.equal(receipt.eventId, "SYNTHETIC-GRAPH-1");
    assert.equal(receipt.invitationTriggered, true);
    assert.equal((await signedBooking({ operation: "book", booking })).status, 200);
    assert.equal((await signedBooking({ operation: "book", booking: {
      ...booking, idempotencyKey: randomUUID() } })).status, 409);
    assert.equal(creates, 1);
    const stored = await db.admin.query(
      "select b.lead_id, b.provider_event_id, b.status from studio_sales_bookings b where b.crm_reference=$1",
      [leadReceipt.reference]);
    assert.equal(stored.rows[0].lead_id, leadReceipt.crmLeadId);
    assert.equal(stored.rows[0].provider_event_id, receipt.eventId);
    assert.equal(stored.rows[0].status, "booked");
    const otherActorRows = await withPublicSubmissionTransaction(
      { actorId: genericActorId, workspaceId: websiteSalesWorkspaceId },
      () => queryRows("select reference from studio_sales_handoffs where reference=$1", [leadReceipt.reference]),
    );
    assert.equal(otherActorRows.length, 0);
    const secondBooking = { ...booking, idempotencyKey: randomUUID(), start: slots.at(-1)!.start };
    timeoutAfterCreate = true;
    const uncertain = await signedBooking({ operation: "book", booking: secondBooking });
    assert.equal((await uncertain.json()).status, "uncertain");
    timeoutAfterCreate = false;
    const changedPolicy = { ...policy, calendarId: "synthetic-other-calendar",
      approvalId: "SYNTHETIC-QA-OTHER" };
    process.env.STUDIO_BOOKING_POLICY_JSON = JSON.stringify(changedPolicy);
    process.env.STUDIO_BOOKING_CONFIG_APPROVAL_ID = changedPolicy.approvalId;
    const mismatched = await signedBooking({ operation: "status",
      idempotencyKey: secondBooking.idempotencyKey, crmReference: leadReceipt.reference });
    assert.equal((await mismatched.json()).status, "uncertain");
    process.env.STUDIO_BOOKING_POLICY_JSON = JSON.stringify(policy);
    process.env.STUDIO_BOOKING_CONFIG_APPROVAL_ID = policy.approvalId;
    const reconciled = await signedBooking({ operation: "status",
      idempotencyKey: secondBooking.idempotencyKey, crmReference: leadReceipt.reference });
    assert.equal((await reconciled.json()).status, "booked");
    assert.equal(creates, 2);
    const phoneBooking = { ...booking, idempotencyKey: randomUUID(), kind: "phone",
      phone: "+353 00 000 0000", start: slots.at(-3)!.start };
    const phoneResult = await signedBooking({ operation: "book", booking: phoneBooking });
    const phoneReceipt = await phoneResult.json();
    assert.equal(phoneReceipt.status, "booked");
    assert.equal(phoneReceipt.teamsUrl, null);
    assert.equal(createdPayloads.at(-1)?.isOnlineMeeting, false);
    assert.equal((createdPayloads.at(-1)?.attendees as Array<{ emailAddress: { address: string } }>)[0].emailAddress.address,
      booking.email);
    const parallelSlot = slots.at(-5)!.start;
    const parallel = await Promise.all([randomUUID(), randomUUID()].map((key) =>
      signedBooking({ operation: "book", booking: { ...booking, idempotencyKey: key,
        start: parallelSlot } })));
    assert.deepEqual(parallel.map((response) => response.status).sort(), [200, 409]);
    assert.equal(creates, 4);
    await db.admin.query(`create function synthetic_studio_finish_failure() returns trigger
      language plpgsql as $$ begin if new.status='booked' then
      raise exception 'SYNTHETIC CRM link failure'; end if; return new; end $$`);
    await db.admin.query(`create trigger synthetic_studio_finish_failure before update
      on studio_sales_bookings for each row execute function synthetic_studio_finish_failure()`);
    const failedLink = { ...booking, idempotencyKey: randomUUID(), start: slots.at(-7)!.start };
    try {
      const result = await signedBooking({ operation: "book", booking: failedLink });
      assert.equal((await result.json()).status, "uncertain");
      assert.equal(creates, 5);
    } finally {
      await db.admin.query("drop trigger if exists synthetic_studio_finish_failure on studio_sales_bookings");
      await db.admin.query("drop function if exists synthetic_studio_finish_failure()");
    }
    const linkRecovered = await signedBooking({ operation: "status",
      idempotencyKey: failedLink.idempotencyKey, crmReference: leadReceipt.reference });
    assert.equal((await linkRecovered.json()).status, "booked");
    assert.equal(creates, 5);
    denyGraph = true;
    const denied = await signedBooking({ operation: "availability", kind: "teams",
      visitorTimeZone: "UTC" });
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).status, "request_only");
    assert.equal(creates, 5);
  } finally { global.fetch = originalFetch; }
});

test("Studio slot generation omits DST gaps and repeated local clocks", () => {
  const policy: StudioCalendarPolicy = { approvalId: "SYNTHETIC-QA-2026",
    organizerId: "synthetic", calendarId: "synthetic", timeZone: "Europe/Dublin",
    durationMinutes: 30, intervalMinutes: 30, minNoticeMinutes: 0, bufferMinutes: 0,
    horizonDays: 1, hours: { "0": [{ start: 60, end: 180 }] } };
  const spring = availableStudioSlots(policy, [], new Date("2026-03-29T00:00:00Z"));
  const autumn = availableStudioSlots(policy, [], new Date("2026-10-25T00:00:00Z"));
  assert.equal(spring.length, 2);
  assert.equal(autumn.length, 2);
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
  assert.deepEqual(directPersistence, { persisted: false, reason: "Tenant transaction required" });

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
  assert.ok(rows.rows.every((row) => row.synthetic === false));
  const submissions = await db.admin.query<{ mode: string }>("select mode from form_submissions where form_id=$1", [websiteSalesFormId]);
  assert.ok(rows.rows.length >= 3);
  assert.equal(submissions.rows.length, rows.rows.length);
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
  assert.equal(lookup?.publicActorId, "");
  assert.equal(lookup?.form.ownerUserId, "");
  assert.equal(lookup?.form.actions.createTask, false);
  const publicIdLookup = await getPublicWebsiteFormByKey(genericFormId);
  assert.equal(publicIdLookup?.id, genericFormId);
  assert.equal(publicIdLookup?.form.ownerUserId, "");
  const data = new FormData();
  data.set("form_slug", publicKey);
  data.set("name", "SYNTHETIC public contact");
  data.set("email", "generic-public@example.invalid");
  data.set("privacy", "true");
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    scope: buildPublicSubmissionScope({ resourceId: genericFormId, resourceType: "form", workspaceId: "synthetic-website-sales" }),
  });
  data.set(publicSubmissionControlFields.idempotencyKey, proof.idempotencyKey);
  data.set(publicSubmissionControlFields.issuedAt, String(proof.issuedAt));
  data.set(publicSubmissionControlFields.expiresAt, String(proof.expiresAt));
  data.set(publicSubmissionControlFields.proof, proof.signature);
  data.set(publicSubmissionControlFields.honeypot, "");
  const originalRequest = new Request("https://crm.example.invalid/api/forms/submissions", {
    body: data,
    headers: { accept: "application/json", "x-test-client-ip": "192.0.2.10" },
    method: "POST",
  });
  const response = await submitGenericForm(originalRequest.clone());
  if (response.status !== 200) assert.fail(await response.text());
  const body = await response.json() as { form: { ownerUserId: string; pipelineStage: string; campaign: string; funnelId: string; actions: { createTask: boolean } } };
  assert.equal(body.form.ownerUserId, "");
  assert.equal(body.form.pipelineStage, "");
  assert.equal(body.form.campaign, "");
  assert.equal(body.form.funnelId, "");
  assert.equal(body.form.actions.createTask, false);
  const row = await db.admin.query<{ workspace_id: string; mode: string }>(
    "select workspace_id,mode from form_submissions where form_id=$1",
    [genericFormId],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].workspace_id, websiteSalesWorkspaceId);
  const replay = await submitGenericForm(originalRequest.clone());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), body);
  assert.equal((await db.admin.query("select id from form_submissions where form_id=$1", [genericFormId])).rowCount, 1);
  data.set("workspaceId", "00000000-0000-4000-8000-000000000001");
  const forged = await submitGenericForm(new Request("https://crm.example.invalid/api/forms/submissions", {
    body: data,
    headers: { accept: "application/json", "x-test-client-ip": "192.0.2.10" },
    method: "POST",
  }));
  assert.equal(forged.status, 400);
  assert.equal((await db.admin.query("select id from form_submissions where form_id=$1", [genericFormId])).rowCount, 1);
});

test("a stale owner session cannot save a form after database membership loses write permission", async () => {
  const lookup = await getPublicWebsiteFormByKey("synthetic-website-sales/generic-public");
  assert.ok(lookup);
  const staleOwner = {
    authenticated: true,
    userId: genericActorId,
    workspaceId: websiteSalesWorkspaceId,
    workspaceName: "SYNTHETIC Website Sales",
    name: "SYNTHETIC public form operator",
    email: "public-form-operator@example.invalid",
    role: "owner",
    productRole: "novalure_operator",
    permissions: getRolePermissions("owner"),
    productPermissions: getProductRoleCapabilities("novalure_operator"),
    source: "database",
  } as AppSession;
  const before = await db.admin.query<{ name: string }>("select name from forms where id=$1", [genericFormId]);
  await db.admin.query("update workspace_users set role='assistant' where id=$1", [genericActorId]);
  try {
    const result = await upsertWebsiteForm({ form: { ...lookup.form, name: "SYNTHETIC forged stale write" }, session: staleOwner });
    assert.deepEqual(result, { form: null, persisted: false, reason: "CRM write permission is required" });
    assert.deepEqual((await db.admin.query<{ name: string }>("select name from forms where id=$1", [genericFormId])).rows, before.rows);
  } finally {
    await db.admin.query("update workspace_users set role='owner' where id=$1", [genericActorId]);
  }
});

test("anonymous lookup uses the application gateway and requires no dedicated database identity", async () => {
  const lookup = await getPublicWebsiteFormByKey("synthetic-website-sales/generic-public");
  assert.equal(lookup?.id, genericFormId);
  const role = await db.admin.query<{ rolcanlogin: boolean; rolpassword: string | null }>(
    "select rolcanlogin,rolpassword from pg_authid where rolname='novalure_public_form_lookup'",
  );
  assert.deepEqual(role.rows[0], { rolcanlogin: false, rolpassword: null });
  assert.equal(process.env.CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL, undefined);
});

test("form publishing requires product authority as well as a writable project", async () => {
  const editorId = randomUUID();
  const writableProjectId = randomUUID();
  const formId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const foreignOwnerId = randomUUID();
  await db.admin.query(
    "insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC foreign form owner','self_service_customer')",
    [foreignWorkspaceId],
  );
  await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC foreign owner',$3,'owner','customer_owner','active')",
    [foreignOwnerId, foreignWorkspaceId, `foreign-form-owner-${foreignOwnerId}@example.invalid`],
  );
  await db.admin.query(
    `insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
     values($1,$2,'SYNTHETIC form editor','form-editor@example.invalid','agent','novalure_operator','active')`,
    [editorId, websiteSalesWorkspaceId],
  );
  await db.admin.query(
    `insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC writable project','Bauträger')`,
    [writableProjectId, websiteSalesWorkspaceId],
  );
  await db.admin.query(
    `insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)
     values($1,$2,$4,true,false),($1,$3,$4,true,true)`,
    [websiteSalesWorkspaceId, projectId, writableProjectId, editorId],
  );
  await db.admin.query(
    `insert into forms(id,workspace_id,project_id,name,slug,status)
     values($1,$2,$3,'SYNTHETIC editable form','editable-form','entwurf')`,
    [formId, websiteSalesWorkspaceId, writableProjectId],
  );
  const session = {
    authenticated: true,
    userId: editorId,
    workspaceId: websiteSalesWorkspaceId,
    workspaceName: "SYNTHETIC Website Sales",
    name: "SYNTHETIC form editor",
    email: "form-editor@example.invalid",
    role: "agent",
    productRole: "novalure_operator",
    permissions: getRolePermissions("agent"),
    productPermissions: getProductRoleCapabilities("novalure_operator"),
    source: "database",
  } as AppSession;
  const loaded = await listWebsiteForms({ session });
  const form = loaded.forms.find((item) => item.id === formId);
  assert.ok(form, "editor can read the form before saving");
  assert.deepEqual(await upsertWebsiteForm({ session, form: { ...form, name: "SYNTHETIC unauthorized edit" } }),
    { form: null, persisted: false, reason: "Form publishing capability is required" });
  assert.equal((await db.admin.query<{ name: string }>("select name from forms where id=$1", [formId])).rows[0].name,
    "SYNTHETIC editable form");
  await db.admin.query("update workspace_users set product_role='novalure_sales' where id=$1", [editorId]);
  const publishingSession = { ...session, productRole: "novalure_sales" as const,
    productPermissions: getProductRoleCapabilities("novalure_sales") };
  const saved = await upsertWebsiteForm({ session: publishingSession, form: { ...form, name: "SYNTHETIC edited form" } });
  assert.equal(saved.persisted, true);
  assert.deepEqual(
    (await db.admin.query("select project_id,name from forms where id=$1", [formId])).rows,
    [{ project_id: writableProjectId, name: "SYNTHETIC edited form" }],
  );
  const foreignOwner = await upsertWebsiteForm({
    session: publishingSession,
    form: { ...form, ownerMode: "user", ownerUserId: foreignOwnerId, name: "SYNTHETIC forged owner" },
  });
  assert.deepEqual(foreignOwner, { form: null, persisted: false, reason: "Form owner is not active in workspace" });
  assert.deepEqual(
    (await db.admin.query("select project_id,name from forms where id=$1", [formId])).rows,
    [{ project_id: writableProjectId, name: "SYNTHETIC edited form" }],
  );
});

test("form saves keep project scope and reject a cross-project funnel", async () => {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const readProjectId = randomUUID();
  const writeProjectId = randomUUID();
  const formId = randomUUID();
  const readFunnelId = randomUUID();
  await db.admin.query(
    `insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC customer workspace','self_service_customer')`,
    [workspaceId],
  );
  await db.admin.query(
    `insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
     values($1,$2,'SYNTHETIC customer editor','customer-form-editor@example.invalid','agent','broker_agent','active')`,
    [editorId, workspaceId],
  );
  await db.admin.query(
    `insert into projects(id,workspace_id,name,type) values
     ($1,$3,'SYNTHETIC read-only project','Bauträger'),
     ($2,$3,'SYNTHETIC writable project','Bauträger')`,
    [readProjectId, writeProjectId, workspaceId],
  );
  await db.admin.query(
    `insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)
     values($1,$2,$4,true,false),($1,$3,$4,true,true)`,
    [workspaceId, readProjectId, writeProjectId, editorId],
  );
  await db.admin.query(
    `insert into forms(id,workspace_id,project_id,name,slug,status,settings)
     values($1,$2,$3,'SYNTHETIC scoped form','scoped-form','entwurf','{"doubleOptIn":true}')`,
    [formId, workspaceId, writeProjectId],
  );
  await db.admin.query(
    `insert into funnels(id,workspace_id,project_id,name,goal,audience,entry_channel)
     values($1,$2,$3,'SYNTHETIC read funnel','lead','buyer','web')`,
    [readFunnelId, workspaceId, readProjectId],
  );
  const session = {
    authenticated: true, userId: editorId, workspaceId,
    workspaceName: "SYNTHETIC customer workspace", name: "SYNTHETIC customer editor",
    email: "customer-form-editor@example.invalid", role: "agent", productRole: "broker_agent",
    permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("broker_agent"),
    source: "database",
  } as AppSession;
  const loaded = await listWebsiteForms({ session });
  const form = loaded.forms.find((item) => item.id === formId);
  assert.ok(form);
  const saved = await upsertWebsiteForm({ session, form: { ...form, name: "SYNTHETIC saved scoped form" } });
  assert.equal(saved.persisted, true);
  assert.equal(saved.form?.doubleOptIn, true);
  assert.deepEqual((await db.admin.query("select project_id,name from forms where id=$1", [formId])).rows,
    [{ project_id: writeProjectId, name: "SYNTHETIC saved scoped form" }]);

  const forgedNewForm = {
    ...form, id: "form_new_synthetic", name: "SYNTHETIC new scoped form", slug: "new-scoped-form",
    workspaceId: websiteSalesWorkspaceId, projectId: readProjectId,
    visits: 999, submissions: 888, conversionRate: 77, lastSubmission: "2026-10-12T00:00:00.000Z",
  };
  const newForm = await upsertWebsiteForm({ session, form: forgedNewForm });
  assert.equal(newForm.persisted, true);
  assert.deepEqual((await db.admin.query(
    "select workspace_id,project_id,visits_count,submissions_count,conversion_rate,last_submission_at from forms where id=$1",
    [newForm.form?.id],
  )).rows,
  [{ workspace_id: workspaceId, project_id: writeProjectId,
    visits_count: 0, submissions_count: 0, conversion_rate: "0.00", last_submission_at: null }]);

  const deniedMove = await upsertWebsiteForm({ session, form: { ...form, funnelId: readFunnelId, name: "SYNTHETIC forbidden move" } });
  assert.equal(deniedMove.persisted, false);
  assert.deepEqual((await db.admin.query("select project_id,name from forms where id=$1", [formId])).rows,
    [{ project_id: writeProjectId, name: "SYNTHETIC saved scoped form" }]);
  const deniedForeignId = await upsertWebsiteForm({ session, form: { ...form, id: genericFormId, name: "SYNTHETIC foreign override" } });
  assert.equal(deniedForeignId.persisted, false);
  assert.equal((await db.admin.query("select count(*)::integer as count from forms where workspace_id=$1", [workspaceId])).rows[0].count, 2);
});

test("a public form cannot reparent or enrich a contact in another project", { timeout: 240_000 }, async () => {
  const otherProjectId = randomUUID();
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC other project','Bauträger')", [otherProjectId, websiteSalesWorkspaceId]);
  await db.admin.query(
    `update forms set fields = fields || '[{"id":"phone","crmField":"phone","label":"Phone","type":"tel","required":false}]'::jsonb where id=$1`,
    [genericFormId],
  );
  for (const identifier of ["email", "phone"] as const) {
    const otherContactId = randomUUID();
    const email = `synthetic-cross-project-${randomUUID()}@example.invalid`;
    const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
    await db.admin.query(
      "insert into contacts(id,workspace_id,project_id,name,role,email,phone,metadata) values($1,$2,$3,'SYNTHETIC original','SYNTHETIC role',$4,$5,'{\"sentinel\":true}'::jsonb)",
      [otherContactId, websiteSalesWorkspaceId, otherProjectId, email, phone],
    );
    const original = await db.admin.query<{ record: Record<string, unknown> }>("select to_jsonb(c) as record from contacts c where id=$1", [otherContactId]);
    const data = new FormData();
    data.set("name", "SYNTHETIC new project contact");
    data.set("email", identifier === "email" ? email : `synthetic-new-${randomUUID()}@example.invalid`);
    data.set("phone", identifier === "phone" ? phone : "+15550000000");
    data.set("privacy", "true");
    await withPublicSubmissionTransaction({ actorId: genericActorId, workspaceId: websiteSalesWorkspaceId }, async () => {
      const result = await persistWebsiteFormSubmission({
        actorUserId: genericActorId,
        formData: data,
        formKey: genericFormId,
        requestUrl: "https://crm.example.invalid/forms/embed",
      });
      assert.equal(result.persisted, true);
    });
    const unchanged = await db.admin.query<{ record: Record<string, unknown> }>("select to_jsonb(c) as record from contacts c where id=$1", [otherContactId]);
    assert.deepEqual(unchanged.rows, original.rows, `${identifier} match cannot mutate another project`);
    const submission = await db.admin.query<{ contact_id: string; project_id: string }>(
      "select contact_id,project_id from form_submissions where form_id=$1 and raw_payload->>'email'=$2 order by created_at desc limit 1",
      [genericFormId, data.get("email")],
    );
    assert.equal(submission.rows[0]?.project_id, projectId);
    assert.notEqual(submission.rows[0]?.contact_id, otherContactId);
    assert.equal((await db.admin.query("select id from contacts where id=$1 and project_id=$2", [submission.rows[0]?.contact_id, projectId])).rowCount, 1);
  }
});

test("duplicate rate keys apply the strictest policy once", async () => {
  const keyHash = "e".repeat(64);
  await withPublicSubmissionTransaction({ actorId: genericActorId, workspaceId: websiteSalesWorkspaceId }, async () => {
    const policies = [
      { keyHash, limit: 5, windowSeconds: 600 },
      { keyHash, limit: 1, windowSeconds: 900 },
    ];
    assert.deepEqual(await consumePublicSubmissionRateLimits({ policies }), { allowed: true });
    assert.deepEqual(await consumePublicSubmissionRateLimits({ policies }), { allowed: false });
  });
});

test("failed public validation does not return the internal form", async () => {
  const data = new FormData();
  data.set("privacy", "false");
  await withPublicSubmissionTransaction({ actorId: genericActorId, workspaceId: websiteSalesWorkspaceId }, async () => {
    assert.deepEqual(await persistWebsiteFormSubmission({
      actorUserId: genericActorId,
      formData: data,
      formKey: genericFormId,
      requestUrl: "https://crm.example.invalid/forms/embed",
    }), { persisted: false, reason: "privacy_consent_required" });
  });
  const publicKey = "synthetic-website-sales/generic-public";
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    scope: buildPublicSubmissionScope({ resourceId: genericFormId, resourceType: "form", workspaceId: "synthetic-website-sales" }),
  });
  data.set("form_slug", publicKey);
  data.set("name", "SYNTHETIC denied contact");
  data.set("email", "denied-public@example.invalid");
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
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "privacy_consent_required", persisted: false });
});

test("public form audit actor must match the bound tenant transaction", async () => {
  const before = await counts();
  await withPublicSubmissionTransaction({ actorId: genericActorId, workspaceId: websiteSalesWorkspaceId }, async () => {
    assert.deepEqual(await persistWebsiteFormSubmission({
      actorUserId: randomUUID(),
      formData: formData(`synthetic-forged-actor-${randomUUID()}@example.invalid`),
      formKey: genericFormId,
      requestUrl: "https://crm.example.invalid/forms/embed",
    }), { persisted: false, reason: "Actor context mismatch" });
  });
  assert.deepEqual(await counts(), before);
});

test("database-backed trusted headers cannot mint an absent workspace session", async () => {
  const priorHeaders = process.env.NOVALURE_TRUST_AUTH_HEADERS;
  const priorDemo = process.env.NOVALURE_DEMO_AUTH_ENABLED;
  try {
    process.env.NOVALURE_TRUST_AUTH_HEADERS = "1";
    delete process.env.NOVALURE_DEMO_AUTH_ENABLED;
    const headers = new Headers({
      "x-novalure-workspace-id": randomUUID(),
      "x-novalure-user-id": randomUUID(),
      "x-novalure-role": "owner",
    });
    assert.equal(await getSessionFromHeaders(headers), null);
  } finally {
    if (priorHeaders === undefined) delete process.env.NOVALURE_TRUST_AUTH_HEADERS;
    else process.env.NOVALURE_TRUST_AUTH_HEADERS = priorHeaders;
    if (priorDemo === undefined) delete process.env.NOVALURE_DEMO_AUTH_ENABLED;
    else process.env.NOVALURE_DEMO_AUTH_ENABLED = priorDemo;
  }
});
