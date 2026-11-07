import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildCrmCsv, buildCrmVcards, parseCrmCsv, previewCrmTransfer } from "../src/lib/crm-transfer";
import { commitCrmImport, exportCrmTransfer, previewCrmImport } from "../src/lib/crm-transfer-repository";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";

test("CSV handles BOM, quoted delimiters, escaped quotes and multiline fields", () => {
  const csv = '\uFEFFname;email;intent\r\n"Müller; Maria";maria@example.invalid;"Text mit ""Zitat""\r\nzweite Zeile"\r\n';
  const parsed = parseCrmCsv(csv);
  assert.deepEqual(parsed.headers, ["name", "email", "intent"]);
  assert.equal(parsed.rows[0][0], "Müller; Maria");
  assert.equal(parsed.rows[0][2], 'Text mit "Zitat"\r\nzweite Zeile');
  assert.equal(previewCrmTransfer(csv).ready, 1);
});

test("CSV rejects malformed quotes, uneven rows, ambiguous headers and excess records", () => {
  for (const csv of ['name,email\n"Anna,a@example.invalid', 'name,email\n"Anna"x,a@example.invalid', 'name,email\nAn"na,a@example.invalid', 'name,email\nAnna,a@example.invalid,extra', 'name,NAME\nA,B', 'name,email\n\0,a@example.invalid']) assert.throws(() => parseCrmCsv(csv));
  assert.throws(() => parseCrmCsv("name,email\n" + Array.from({ length: 1001 }, (_, i) => `Name${i},user${i}@example.invalid`).join("\n")), /1.000/);
});

test("mapped preview rejects privilege fields and deduplicates normalized phone/email without changing existing data", () => {
  const csv = "Person,Mail,Mobil\nAnna,ANNA@example.invalid,+43 660 1234567\nAnna again,other@example.invalid,0043 660 1234567\nInvalid,bad-mail,123\nExisting,existing@example.invalid,";
  const existing = [{ email: "EXISTING@example.invalid", phone: null }];
  const preview = previewCrmTransfer(csv, { name: "Person", email: "Mail", phone: "Mobil" }, existing);
  assert.deepEqual([preview.ready, preview.duplicates, preview.invalid], [1, 2, 1]);
  assert.deepEqual(existing, [{ email: "EXISTING@example.invalid", phone: null }]);
  assert.throws(() => previewCrmTransfer(csv, { name: "Person", email: "Mail", ownerUserId: "Mobil" } as never));
  assert.throws(() => previewCrmTransfer(csv, { name: "Person", email: "Person" }));
});

test("CSV export protects formulas even behind whitespace and roundtrips quoted text", () => {
  const csv = buildCrmCsv(["name", "phone", "email"], [["=HYPERLINK(\"evil\")", "+43 660 1234567", "a@example.invalid"], [" \t@SUM(A1)", "-12345", "b@example.invalid"], ["\tplain", "12345", "c@example.invalid"]]);
  const parsed = parseCrmCsv(csv);
  assert.equal(parsed.rows[0][0], "'=HYPERLINK(\"evil\")");
  assert.equal(parsed.rows[1][0], "' \t@SUM(A1)");
  assert.equal(parsed.rows[2][0], "'\tplain");
  const preview = previewCrmTransfer(csv);
  assert.equal(preview.rows[0].contact.phone, "+43 660 1234567");
});

test("vCard escapes line injection and folds Unicode on UTF-8 octet boundaries", () => {
  const content = buildCrmVcards([{ id: randomUUID(), name: "Ä".repeat(80) + ";Admin\r\nEMAIL:evil@example.invalid", email: "safe@example.invalid", phone: "+43 660 1234567" }]);
  assert.equal(content.split("\r\n").filter(line => line.startsWith("EMAIL:")).length, 1);
  assert.match(content, /\\;Admin\\nEMAIL:/);
  for (const line of content.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.doesNotMatch(content, /\uFFFD/);
});

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
// The local pg adapter implements the transaction methods used by the Neon pool contract.
const testOptions = () => ({ pool: db.pool as unknown as TenantPool });
const workspaceId = randomUUID(), foreignWorkspace = randomUUID(), actorId = randomUUID(), agentId = randomUUID(), otherId = randomUUID(), foreignActor = randomUUID();
const projectId = randomUUID(), hiddenProject = randomUUID(), foreignProject = randomUUID(), ownContact = randomUUID(), otherContact = randomUUID();
const session = (userId = actorId, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession => ({ authenticated: true, userId, workspaceId, workspaceName: "SYNTHETIC transfer", name: "SYNTHETIC tester", email: "tester@example.invalid", role, permissions: [], productRole, productPermissions: [], source: "database" });

before(async () => {
  db = await startLocalSalesDb();
  await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Transfer','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [workspaceId, foreignWorkspace]);
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$5,'SYNTHETIC Owner','owner@example.invalid','owner','customer_owner','active'),($2,$5,'SYNTHETIC Agent','agent@example.invalid','agent','project_sales_member','active'),($3,$5,'SYNTHETIC Other','other@example.invalid','agent','project_sales_member','active'),($4,$6,'SYNTHETIC Foreign','foreign@example.invalid','owner','customer_owner','active')", [actorId, agentId, otherId, foreignActor, workspaceId, foreignWorkspace]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Granted','Wohnbau'),($2,$4,'SYNTHETIC Hidden','Wohnbau'),($3,$5,'SYNTHETIC Foreign','Wohnbau')", [projectId, hiddenProject, foreignProject, workspaceId, foreignWorkspace]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, agentId]);
  for (const [id, owner, name, email, project, workspace] of [[ownContact, agentId, "=SYNTHETIC Own", "own@example.invalid", projectId, workspaceId], [otherContact, otherId, "SYNTHETIC Other", "other@example.invalid", projectId, workspaceId], [randomUUID(), actorId, "SYNTHETIC Hidden", "hidden@example.invalid", hiddenProject, workspaceId], [randomUUID(), foreignActor, "SYNTHETIC Foreign", "foreign@example.invalid", foreignProject, foreignWorkspace]]) {
    await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role,phone) values($1,$2,$3,$4,$5,$6,'Käufer','+43 660 1234567')", [id, workspace, project, owner, name, email]);
  }
  await db.admin.query("insert into leads(workspace_id,project_id,contact_id,assigned_to_user_id,type,intent) values($1,$2,$3,$4,'Käufer','SYNTHETIC Own enquiry'),($1,$2,$5,$6,'Käufer','SYNTHETIC Other enquiry')", [workspaceId, projectId, ownContact, agentId, otherContact, otherId]);
});
after(async () => { if (db) await db.stop(); });

test("database export enforces current tenant, owner visibility, project grants and exact selections", async () => {
  const agent = session(agentId, "agent", "project_sales_member");
  const contacts = await exportCrmTransfer(agent, { kind: "contacts", format: "csv" }, testOptions());
  assert.equal(contacts.count, 1); assert.match(contacts.content, /'=SYNTHETIC Own/); assert.doesNotMatch(contacts.content, /other@example|hidden@example|foreign@example/);
  const leads = await exportCrmTransfer(agent, { kind: "leads", format: "csv", projectId }, testOptions());
  assert.equal(leads.count, 1); assert.match(leads.content, /Own enquiry/); assert.doesNotMatch(leads.content, /Other enquiry/);
  await assert.rejects(exportCrmTransfer(agent, { kind: "contacts", format: "csv", projectId: hiddenProject }, testOptions()), /Project access/);
  await assert.rejects(exportCrmTransfer(session(), { kind: "contacts", format: "csv", projectId: foreignProject }, testOptions()), /Project access/);
  await assert.rejects(exportCrmTransfer(agent, { kind: "contacts", format: "vcf", ids: [otherContact] }, testOptions()), /nicht verfügbare/);
});

test("database import revalidates grants and preview never creates business records", async () => {
  const input = { csv: "name,email,phone\nSYNTHETIC New,new@example.invalid,+49 123456789", projectId, createLeads: true };
  const beforeCount = await db.admin.query("select count(*) from contacts");
  const preview = await previewCrmImport(session(), input, testOptions()); assert.equal(preview.ready, 1);
  assert.deepEqual((await db.admin.query("select count(*) from contacts")).rows, beforeCount.rows);
  await assert.rejects(previewCrmImport(session(agentId, "agent", "project_sales_member"), { ...input, projectId: foreignProject }, testOptions()), /Project access/);
});

test("database commit is atomic, preserves provenance, creates no marketing grant and replays exactly once", async () => {
  const input = { csv: "id,name,email,phone\nsource-42,SYNTHETIC Imported,imported@example.invalid,+49 111111111\nsource-43,SYNTHETIC Duplicate,IMPORTED@example.invalid,+49 222222222", projectId, createLeads: true, idempotencyKey: randomUUID(), correlationId: randomUUID() };
  const [first, replay] = await Promise.all([commitCrmImport(session(), input, testOptions()), commitCrmImport(session(), input, testOptions())]);
  assert.deepEqual(first.data, replay.data); assert.equal(Number(first.replayed) + Number(replay.replayed), 1);
  assert.equal(first.data.created.length, 1); assert.equal(first.data.skippedDuplicates, 1); assert.equal(first.data.consentImported, false);
  const contactId = first.data.created[0].contactId;
  assert.equal((await db.admin.query("select metadata #>> '{crmTransfer,sourceId}' as source from contacts where id=$1", [contactId])).rows[0].source, "source-42");
  assert.equal((await db.admin.query("select count(*) from leads where contact_id=$1", [contactId])).rows[0].count, "1");
  assert.ok((await db.admin.query("select status from consent_records where contact_id=$1", [contactId])).rows.every(row => row.status === "Nur CRM"));
  await assert.rejects(commitCrmImport(session(), { ...input, csv: input.csv.replace("SYNTHETIC Imported", "SYNTHETIC Changed") }, testOptions()), /different command/);
});

test("database commit rolls back earlier rows and receipt if a later contact write fails", async () => {
  await db.admin.query("create function qa_transfer_reject() returns trigger language plpgsql as $$ begin if new.name='SYNTHETIC Reject' then raise exception 'Synthetic transfer failure'; end if; return new; end $$");
  await db.admin.query("create trigger qa_transfer_reject before insert on contacts for each row execute function qa_transfer_reject()");
  const key = randomUUID();
  try {
    await assert.rejects(commitCrmImport(session(), { csv: "name,email\nSYNTHETIC Rollback,rollback@example.invalid\nSYNTHETIC Reject,reject@example.invalid", projectId, createLeads: false, idempotencyKey: key, correlationId: randomUUID() }, testOptions()), /Synthetic transfer failure/);
    assert.equal((await db.admin.query("select count(*) from contacts where email in ('rollback@example.invalid','reject@example.invalid')")).rows[0].count, "0");
    assert.equal((await db.admin.query("select count(*) from crm_command_receipts where idempotency_key=$1", [key])).rows[0].count, "0");
  } finally { await db.admin.query("drop trigger qa_transfer_reject on contacts"); await db.admin.query("drop function qa_transfer_reject()"); }
});
