import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { parseCrmActivityInput } from "../src/lib/crm-activity";
import { readCrmActivity, recordCrmActivity } from "../src/lib/crm-activity-repository";
import { withCrmRead } from "../src/lib/crm-command";
import { createAutomationGraph } from "../src/lib/automation/graph";
import { enrollAutomationLead, saveAutomation, setAutomationStatus } from "../src/lib/automation/repository";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("activity input accepts only manual facts and strict dates, never delivery or authority overrides", () => {
  const input = { contactId: randomUUID(), kind: "note", detail: "  Reviewed enquiry  " };
  assert.equal(parseCrmActivityInput(input).detail, "Reviewed enquiry");
  for (const extra of [{ metadata: { delivered: true } }, { workspaceId: randomUUID() }, { ownerUserId: randomUUID() }, { kind: "email_sent" }, { detail: "x".repeat(1201) }, { occurredAt: "2026-02-30T09:00:00Z" }, { occurredAt: "2026-11-04T24:00:00Z" }, { occurredAt: "2026-11-04T09:00:00" }]) assert.throws(() => parseCrmActivityInput({ ...input, ...extra }));
});

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const w = randomUUID(), foreignW = randomUUID(), owner = randomUUID(), agent = randomUUID(), other = randomUUID(), foreignActor = randomUUID();
const project = randomUUID(), hiddenProject = randomUUID(), foreignProject = randomUUID(), contact = randomUUID(), otherContact = randomUUID(), hiddenContact = randomUUID(), foreignContact = randomUUID(), privateContact = randomUUID(), pagedContact = randomUUID();
const lead = randomUUID(), secondLead = randomUUID(), hiddenLead = randomUUID(), foreignLead = randomUUID(), inquiryId = randomUUID(), generalNoteId = randomUUID(), secondNoteId = randomUUID(), hiddenEntryId = randomUUID();
const options = () => ({ pool: db.pool as unknown as TenantPool });
const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
function session(actor = owner, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession { return { authenticated: true, userId: actor, workspaceId: w, workspaceName: "SYNTHETIC Activity", name: "SYNTHETIC actor", email: "actor@example.invalid", role, productRole, permissions: [], productPermissions: [], source: "database" }; }

before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query(await readFile("migrations/154_automation_graph.sql", "utf8"));
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Activity','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [w, foreignW]);
  for (const [id, workspace, name, role, productRole] of [[owner, w, "Owner", "owner", "customer_owner"], [agent, w, "Agent", "agent", "project_sales_member"], [other, w, "Other", "agent", "project_sales_member"], [foreignActor, foreignW, "Foreign", "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')", [id, workspace, "SYNTHETIC " + name, String(name).toLowerCase() + "@example.invalid", role, productRole]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Granted','Test'),($2,$4,'SYNTHETIC Hidden','Test'),($3,$5,'SYNTHETIC Foreign','Test')", [project, hiddenProject, foreignProject, w, foreignW]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [w, project, agent]);
  for (const [id, workspace, target, actor, classification] of [[contact, w, project, agent, "CUSTOMER_TENANT"], [otherContact, w, project, other, "CUSTOMER_TENANT"], [hiddenContact, w, hiddenProject, agent, "CUSTOMER_TENANT"], [foreignContact, foreignW, foreignProject, foreignActor, "CUSTOMER_TENANT"], [privateContact, w, project, agent, "PRIVATE_FRANZ"], [pagedContact, w, project, agent, "CUSTOMER_TENANT"]]) await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,role,data_classification) values($1,$2,$3,$4,'SYNTHETIC Activity contact','Käufer',$5)", [id, workspace, target, actor, classification]);
  for (const [id, workspace, target, customer, actor] of [[lead, w, project, contact, agent], [secondLead, w, project, contact, agent], [hiddenLead, w, hiddenProject, hiddenContact, agent], [foreignLead, foreignW, foreignProject, foreignContact, foreignActor]]) await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type) values($1,$2,$3,$4,$5,'Käufer')", [id, workspace, target, customer, actor]);
  for (const [id, customer, target, channel, title, metadata] of [[inquiryId, contact, project, "Website", "SYNTHETIC web enquiry", { leadId: lead, source: "web_expose", secretProviderToken: "MUST_NOT_LEAK" }], [generalNoteId, contact, project, "Notiz", "SYNTHETIC general note", { source: "crm_notes", createdByUserId: agent }], [secondNoteId, contact, project, "Notiz", "SYNTHETIC second lead note", { leadId: secondLead, source: "crm_notes" }], [hiddenEntryId, contact, hiddenProject, "Notiz", "SYNTHETIC hidden project note", { leadId: lead, source: "crm_notes" }]]) await db.admin.query("insert into contact_timeline_items(id,workspace_id,contact_id,project_id,channel,title,detail,metadata) values($1,$2,$3,$4,$5,$6,'SYNTHETIC detail',$7::jsonb)", [id, w, customer, target, channel, title, JSON.stringify(metadata)]);
});
after(async () => { if (db) await db.stop(); });

test("activity reads include persisted web enquiries and general notes without leaking other lead/project data or metadata", async () => {
  const result = await readCrmActivity(session(agent, "agent", "project_sales_member"), { leadId: lead, projectId: project }, options());
  assert.equal(result.canRecord, true); assert.equal(result.contactId, contact); assert.equal(result.source, "database");
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set([inquiryId, generalNoteId]));
  assert.equal(result.items.find(item => item.id === inquiryId)?.kind, "inquiry");
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK|secretProviderToken|hidden project note|second lead note/);
  const second = await readCrmActivity(session(agent, "agent", "project_sales_member"), { leadId: secondLead }, options());
  assert.deepEqual(new Set(second.items.map(item => item.id)), new Set([secondNoteId, generalNoteId]));
  const customer = await readCrmActivity(session(), { contactId: contact, projectId: project }, options());
  assert.equal(customer.items.length, 3);
});

test("contact ownership, tenant/classification/project boundaries and revoked grants are checked before reading or writing", async () => {
  const actor = session(agent, "agent", "project_sales_member");
  for (const scope of [{ contactId: otherContact }, { leadId: hiddenLead }, { contactId: foreignContact }, { leadId: foreignLead }, { contactId: privateContact }, { leadId: lead, contactId: otherContact }, { contactId: contact, projectId: hiddenProject }]) {
    await assert.rejects(readCrmActivity(actor, scope, options()));
    await assert.rejects(recordCrmActivity(actor, { ...scope, kind: "note", detail: "SYNTHETIC forbidden" }, meta(), options()));
  }
  await db.admin.query("update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, agent]);
  try {
    assert.equal((await readCrmActivity(actor, { contactId: contact }, options())).canRecord, false);
    await assert.rejects(recordCrmActivity(actor, { contactId: contact, kind: "note", detail: "SYNTHETIC revoked" }, meta(), options()));
  } finally { await db.admin.query("update project_pipeline_permissions set can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, agent]); }
});

test("manual notes are audited and concurrent retries produce one entry; changed retries are rejected", async () => {
  const actor = session(agent, "agent", "project_sales_member"), metadata = meta();
  const input = { contactId: contact, leadId: lead, projectId: project, kind: "note" as const, detail: "SYNTHETIC once" };
  const [first, retry] = await Promise.all([recordCrmActivity(actor, input, metadata, options()), recordCrmActivity(actor, input, metadata, options())]);
  assert.deepEqual(first.data, retry.data); assert.equal(Number(first.replayed) + Number(retry.replayed), 1);
  assert.equal(first.data.item.evidence, "manual"); assert.equal(first.data.externalSend, false);
  assert.equal((await db.admin.query("select count(*) from contact_timeline_items where workspace_id=$1 and detail='SYNTHETIC once'", [w])).rows[0].count, "1");
  assert.equal((await db.admin.query("select action from audit_logs where id=$1", [first.auditReference])).rows[0].action, "crm.activity.note");
  await assert.rejects(recordCrmActivity(actor, { ...input, detail: "SYNTHETIC different" }, metadata, options()), /different command/);
});

test("cursor pages preserve microsecond ordering and never skip or duplicate equal-time records", async () => {
  const ids = Array.from({ length: 63 }, () => randomUUID());
  for (const id of ids) await db.admin.query("insert into contact_timeline_items(id,workspace_id,contact_id,project_id,channel,title,occurred_at) values($1,$2,$3,$4,'Notiz','SYNTHETIC pagination','2026-10-30T10:00:00.123456Z')", [id, w, pagedContact, project]);
  const first = await readCrmActivity(session(), { contactId: pagedContact }, options());
  assert.equal(first.items.length, 40); assert.ok(first.nextCursor); assert.match(first.items[0].occurredAt, /123456Z$/);
  const second = await readCrmActivity(session(), { contactId: pagedContact, cursor: first.nextCursor! }, options());
  assert.equal(second.items.length, 23); assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(ids));
  await assert.rejects(readCrmActivity(session(), { contactId: pagedContact, cursor: "broken" }, options()), /Seitenmarkierung/);
});

test("a manual call attempt keeps a flow running; reported personal contact stops it in the same transaction", async () => {
  const graph = createAutomationGraph(); graph.businessHours = false;
  const definition = await withCrmRead(session(), (tx, fresh) => saveAutomation(tx, fresh, { projectId: project, name: "SYNTHETIC contact stop", graph }), options());
  await withCrmRead(session(), (tx, fresh) => setAutomationStatus(tx, fresh, { id: definition.id, expectedRevision: 1, active: true }), options());
  await withCrmRead(session(), (tx, fresh) => enrollAutomationLead(tx, fresh, { automationId: definition.id, leadId: lead, eventId: randomUUID() }), options());
  await db.admin.query("update crm_automation_enrollments set enrolled_at=now()-interval '1 second' where automation_id=$1", [definition.id]);
  const actor = session(agent, "agent", "project_sales_member");
  const attempt = await recordCrmActivity(actor, { leadId: lead, kind: "call_attempt", detail: "SYNTHETIC no answer" }, meta(), options());
  assert.equal(attempt.data.item.kind, "call_attempt"); assert.equal(attempt.data.automationSignalRecorded, false);
  assert.equal((await db.admin.query("select status from crm_automation_enrollments where automation_id=$1", [definition.id])).rows[0].status, "running");
  const connected = await recordCrmActivity(actor, { leadId: lead, kind: "call_connected", detail: "SYNTHETIC conversation documented" }, meta(), options());
  assert.equal(connected.data.automationSignalRecorded, true); assert.equal(connected.data.item.evidence, "manual"); assert.equal(connected.data.externalSend, false);
  const stopped = (await db.admin.query("select status,stop_reason from crm_automation_enrollments where automation_id=$1", [definition.id])).rows[0];
  assert.deepEqual(stopped, { status: "stopped", stop_reason: "personal_contact" });
});

test("a failing automation signal rolls back its activity and command receipt", async () => {
  await db.admin.query("create function qa_activity_signal_reject() returns trigger language plpgsql as $$ begin if new.trigger_key='personal_contact' then raise exception 'Synthetic activity signal failure'; end if; return new; end $$");
  await db.admin.query("create trigger qa_activity_signal_reject before insert on crm_automation_events for each row execute function qa_activity_signal_reject()");
  const metadata = meta();
  try {
    await assert.rejects(recordCrmActivity(session(), { leadId: lead, kind: "call_connected", detail: "SYNTHETIC must rollback" }, metadata, options()), /Synthetic activity signal failure/);
    assert.equal((await db.admin.query("select count(*) from contact_timeline_items where detail='SYNTHETIC must rollback'")).rows[0].count, "0");
    assert.equal((await db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1", [metadata.idempotencyKey])).rows[0].count, "0");
  } finally { await db.admin.query("drop trigger qa_activity_signal_reject on crm_automation_events"); await db.admin.query("drop function qa_activity_signal_reject()"); }
});
