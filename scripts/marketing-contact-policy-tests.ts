import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startLocalSalesDb, applySalesSchema } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { readMarketingContactPolicy, saveMarketingContactPolicy, checkMarketingContactPolicy } from "../src/lib/db/marketing-contact-policy-repository";
import { withCrmRead } from "../src/lib/crm-command";
import { defaultMarketingContactRules, nextMarketingContactTime, normalizeMarketingContactRules } from "../src/lib/marketing-contact-policy";
import { automationMessageVariableIssues } from "../src/lib/automation/message-variables";
import { automationStarters, createAutomationStarter } from "../src/lib/automation/starters";
import { previewAutomation } from "../src/lib/automation/graph";

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const w = randomUUID(), owner = randomUUID(), agent = randomUUID(), foreignW = randomUUID(), foreignOwner = randomUUID(), project = randomUUID(), contact = randomUUID();
const meta = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
const session = (actor = owner, target = w): AppSession => ({ authenticated: true, source: "database", userId: actor, workspaceId: target, workspaceName: "SYNTHETIC Contact policy", name: "Synthetic actor", email: "actor@example.invalid", role: actor === agent ? "agent" : "owner", productRole: actor === agent ? "project_sales_member" : "customer_owner", permissions: [], productPermissions: [] });
const options = () => ({ pool: db.pool as unknown as TenantPool });
before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 }); await db.admin.query(await readFile("migrations/183_marketing_contact_policy.sql", "utf8"));
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Policy','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [w, foreignW]);
  for (const [id, target, role, product] of [[owner, w, "owner", "customer_owner"], [agent, w, "agent", "project_sales_member"], [foreignOwner, foreignW, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC Actor',$3,$4,$5,'active')", [id, target, `${id}@example.invalid`, role, product]);
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC Project','Test')", [project, w]);
  await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [w, project, agent]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,'SYNTHETIC Contact','contact@example.invalid','Käufer')", [contact, w, project, agent]);
});
after(async () => { await db?.stop(); });

test("explicit timezone, quarter-hour windows, weekends and exception dates survive DST", () => {
  const rules = normalizeMarketingContactRules({ ...defaultMarketingContactRules, enabled: true, startMinute: 555, endMinute: 1020, excludedDates: ["2026-10-26"] });
  assert.equal(nextMarketingContactTime(new Date("2026-10-23T18:00:00Z"), rules).toISOString(), "2026-10-27T08:15:00.000Z");
  const dublin = { ...rules, timezone: "Europe/Dublin", excludedDates: [] };
  assert.equal(nextMarketingContactTime(new Date("2026-10-23T18:00:00Z"), dublin).toISOString(), "2026-10-26T09:15:00.000Z");
  assert.throws(() => normalizeMarketingContactRules({ ...rules, excludedDates: ["2026-02-30"] }), /Datumswerte/);
  assert.throws(() => normalizeMarketingContactRules({ ...rules, days: [] }), /Wochentag/);
});

test("workspace rule save is versioned, idempotent, audited and manager-only", async () => {
  const initial = await readMarketingContactPolicy(session(), options()); assert.equal(initial.policy!.revision, 0);
  const input = { expectedRevision: 0, rules: { ...defaultMarketingContactRules, enabled: true } }, metadata = meta();
  const first = await saveMarketingContactPolicy(session(), input, metadata, options());
  const replay = await saveMarketingContactPolicy(session(), input, metadata, options());
  assert.equal(first.data.policy.revision, 1); assert.equal(replay.replayed, true);
  await assert.rejects(saveMarketingContactPolicy(session(), input, meta(), options()), /geändert/);
  await assert.rejects(saveMarketingContactPolicy(session(agent), { expectedRevision: 1, rules: input.rules }, meta(), options()), /manager|denied|granted|permission/i);
  assert.equal((await readMarketingContactPolicy(session(foreignOwner, foreignW), options())).policy!.revision, 0);
  const audit = await db.admin.query("select count(*)::integer as count from crm_command_receipts where workspace_id=$1 and operation='marketing.contact_policy.save'", [w]);
  assert.equal(audit.rows[0].count, 1);
});

test("current original contact and ownership govern the shared send gate", async () => {
  const read = (email: string, actor = agent) => withCrmRead(session(actor), (tx, fresh) => checkMarketingContactPolicy(tx, fresh, { contactId: contact, email, lock: true }, new Date("2026-11-07T12:00:00Z")), options());
  const weekend = await read("contact@example.invalid"); assert.equal(weekend.allowed, false); assert.equal(weekend.nextAllowedAt, "2026-11-09T07:00:00.000Z");
  assert.equal((await read("different@example.invalid")).nextAllowedAt, null);
  await db.admin.query("update contacts set owner_user_id=$1 where id=$2", [owner, contact]);
  assert.equal((await read("contact@example.invalid")).nextAllowedAt, null);
});

test("all starters preview without side effects and unknown or missing variables remain actionable", () => {
  for (const starter of automationStarters) {
    const graph = createAutomationStarter(starter.id);
    const result = previewAutomation(graph, { phone: null, address: null, phase: "Neu", inquiry: "Example", exposeOpened: null, replied: false, booked: null, proofAccepted: null, searchProfileExists: null, matchScore: null, optedOut: false, personalContact: false });
    assert.ok(result.steps.length >= 2);
  }
  assert.deepEqual(automationMessageVariableIssues("Hello {{contact.name}}", "{{project.name}}", { contactName: "", projectName: "Project", agentName: "Agent" }), ["Pflichtvariable fehlt: {{contact.name}}"]);
  assert.match(automationMessageVariableIssues("Hello {{contact.secret}}", "Text")[0], /Unbekannte/);
});
