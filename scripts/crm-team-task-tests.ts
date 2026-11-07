import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { Task } from "../src/lib/crm-types";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { readCrmTeam } from "../src/lib/db/crm-team-repository";
import { upsertTaskRecord } from "../src/lib/db/crm-write-repositories";
import { withCrmRead } from "../src/lib/crm-command";
import { compareTaskDue, defaultTaskDueInput, formatTaskDue, mergeConfirmedTasks, nextOpenTaskForLead, taskDueState, taskLocalDateTimeToInstant } from "../src/lib/task-due";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

test("today and overdue are disjoint groups using an exact time in the chosen timezone", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  assert.equal(taskDueState("2026-11-04T11:00:00Z", now, "Europe/Vienna").group, "overdue");
  assert.equal(taskDueState("2026-11-04T13:00:00Z", now, "Europe/Vienna").group, "today");
  assert.equal(taskDueState("2026-11-05T13:00:00Z", now, "Europe/Vienna").group, "upcoming");
  assert.equal(taskDueState("2026-11-04", now, "Europe/Vienna").group, "today");
  assert.equal(taskDueState("2026-11-04", new Date("2026-11-04T23:00:00Z"), "Europe/Vienna").group, "overdue");
});

test("date-only tasks follow local midnight and timestamps are independent of display language", () => {
  const now = new Date("2026-11-04T23:30:00Z");
  assert.equal(taskDueState("2026-11-04", now, "Europe/Dublin").group, "today");
  assert.equal(taskDueState("2026-11-04", now, "Europe/Vienna").group, "overdue");
  assert.equal(defaultTaskDueInput(now, "Europe/Dublin"), "2026-11-05T09:00");
  assert.equal(defaultTaskDueInput(now, "Europe/Vienna"), "2026-11-06T09:00");
  assert.match(formatTaskDue("2026-11-05T09:00:00Z", "de", "Europe/Dublin", now), /09:00/);
  assert.match(formatTaskDue("2026-11-05T09:00:00Z", "en", "Europe/Vienna", now), /10:00/);
});

test("DST gaps are rejected and repeated local hours resolve consistently", () => {
  assert.equal(taskLocalDateTimeToInstant("2026-03-29T02:30", "Europe/Vienna"), null);
  assert.equal(taskLocalDateTimeToInstant("2026-10-25T02:30", "Europe/Vienna")?.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(taskLocalDateTimeToInstant("2026-03-29T01:30", "Europe/Dublin"), null);
  assert.equal(taskLocalDateTimeToInstant("2026-11-04T09:00", "Europe/Madrid")?.toISOString(), "2026-11-04T08:00:00.000Z");
  assert.equal(taskLocalDateTimeToInstant("2026-11-04T09:00", "Europe/Dublin")?.toISOString(), "2026-11-04T09:00:00.000Z");
});

test("invalid and ambiguous legacy dates are undated instead of fabricated deadlines", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  for (const value of ["", "not a date", "Diese Woche", "2026-02-30", "2026-11-04T24:00:00Z", "2026-11-04T12:70:00Z", "2026-11-04T09:00:70Z", "Heute 25:00"]) assert.equal(taskDueState(value, now).group, "undated", value);
  assert.equal(taskDueState("Heute 12:00", now, "Europe/Vienna").group, "overdue");
  assert.equal(taskDueState("Tomorrow", now, "Europe/Vienna").group, "upcoming");
  assert.equal(taskDueState("2026-11-04", now, "Invalid/Timezone").group, "undated");
});

test("next task excludes completed, other lead, other project and other tenant records", () => {
  const lead = { id: "lead", workspaceId: "workspace", projectId: "project" }, now = new Date("2026-11-04T12:00:00Z");
  const base: Task = { id: "base", workspaceId: lead.workspaceId, projectId: lead.projectId, leadId: lead.id, title: "Task", project: "Test", due: "2026-11-05", priority: "Normal", status: "open" };
  const tasks: Task[] = [{ ...base, id: "foreign", workspaceId: "foreign", due: "2026-01-01" }, { ...base, id: "other-project", projectId: "other", due: "2026-01-01" }, { ...base, id: "other-lead", leadId: "other", due: "2026-01-01" }, { ...base, id: "done", status: "done", due: "2026-01-01" }, { ...base, id: "undated", due: "broken", priority: "Hoch" }, { ...base, id: "overdue", due: "2026-11-03" }, base];
  const originalIds = tasks.map(task => task.id);
  assert.equal(nextOpenTaskForLead(tasks, lead, now)?.id, "overdue");
  assert.deepEqual(tasks.map(task => task.id), originalIds);
  assert.ok(compareTaskDue({ ...base, priority: "Hoch" }, base, now) < 0);
});

test("a fresh server revision cannot resurrect completed work from an older confirmed display copy",()=>{
  const lead={id:"lead",workspaceId:"workspace",projectId:"project"},base:Task={...lead,id:"task",leadId:lead.id,title:"Task",project:"Test",due:"2026-11-05",priority:"Normal",status:"open",version:1};
  const completed={...base,status:"done" as const,version:2};
  assert.equal(nextOpenTaskForLead(mergeConfirmedTasks([completed],[base]),lead),null);
  assert.equal(nextOpenTaskForLead(mergeConfirmedTasks([base],[completed]),lead),null);
  assert.equal(mergeConfirmedTasks([completed],[{...base,workspaceId:"foreign",version:99}]).find(task=>task.workspaceId===lead.workspaceId)?.status,"done");
});

let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
const w = randomUUID(), foreignW = randomUUID(), owner = randomUUID(), agent = randomUUID(), colleague = randomUUID(), hidden = randomUUID(), viewer = randomUUID(), suspended = randomUUID(), invited = randomUUID(), foreignActor = randomUUID();
const project = randomUUID(), otherProject = randomUUID(), foreignProject = randomUUID(), leadId = randomUUID(), contactId = randomUUID();
const options = () => ({ pool: db.pool as unknown as TenantPool });
function session(actor = owner, role: AppSession["role"] = "owner", productRole: AppSession["productRole"] = "customer_owner"): AppSession { return { authenticated: true, userId: actor, workspaceId: w, workspaceName: "SYNTHETIC Team", email: "synthetic@example.invalid", name: "SYNTHETIC", role, productRole, permissions: [], productPermissions: [], source: "database" }; }
before(async () => {
  db = await startLocalSalesDb(); await applySalesSchema(db, { maxMigrationNumber: 106 });
  await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'SYNTHETIC Team','self_service_customer'),($2,'SYNTHETIC Foreign','self_service_customer')", [w, foreignW]);
  for (const [id, workspace, name, role, productRole, status] of [[owner, w, "Owner", "owner", "customer_owner", "active"], [agent, w, "Agent", "agent", "project_sales_member", "active"], [colleague, w, "Colleague", "agent", "project_sales_member", "active"], [hidden, w, "Hidden", "agent", "project_sales_member", "active"], [viewer, w, "Viewer", "assistant", "viewer", "active"], [suspended, w, "Suspended", "agent", "project_sales_member", "suspended"], [invited, w, "Invited", "agent", "project_sales_member", "invited"], [foreignActor, foreignW, "Foreign", "owner", "customer_owner", "active"]]) {
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,$7)", [id, workspace, "SYNTHETIC " + name, String(name).toLowerCase() + "@example.invalid", role, productRole, status]);
  }
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$4,'SYNTHETIC Granted','Test'),($2,$4,'SYNTHETIC Hidden','Test'),($3,$5,'SYNTHETIC Foreign','Test')", [project, otherProject, foreignProject, w, foreignW]);
  for (const [actor, target] of [[agent, project], [colleague, project], [hidden, otherProject], [viewer, project], [suspended, project], [invited, project]]) await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [w, target, actor]);
  await db.admin.query("insert into contacts(id,workspace_id,project_id,owner_user_id,name,role) values($1,$2,$3,$4,'SYNTHETIC Task contact','Käufer')", [contactId, w, project, agent]);
  await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type) values($1,$2,$3,$4,$5,'Käufer')", [leadId, w, project, contactId, agent]);
});
after(async () => { if (db) await db.stop(); });

test("team options expose active authorized recipients and no hidden or foreign members", async () => {
  const result = await readCrmTeam(session(agent, "agent", "project_sales_member"), project, options());
  assert.equal(result.currentUserId, agent); assert.equal(result.scope, "project");
  assert.deepEqual(new Set(result.members.map(member => member.id)), new Set([owner, agent, colleague]));
  assert.ok(result.members.every(member => member.workspaceId === w && member.status === "active"));
  assert.doesNotMatch(JSON.stringify(result), /hidden@example|foreign@example|viewer@example|invited@example|suspended@example/);
  const self = await readCrmTeam(session(agent, "agent", "project_sales_member"), undefined, options());
  assert.equal(self.scope, "self"); assert.deepEqual(self.members.map(member => member.id), [agent]);
  const all = await readCrmTeam(session(), undefined, options());
  assert.equal(all.scope, "workspace"); assert.deepEqual(new Set(all.members.map(member => member.id)), new Set([owner, agent, colleague, hidden]));
});

test("team project grants are revalidated and revoked candidate rights stop appearing immediately", async () => {
  await assert.rejects(readCrmTeam(session(agent, "agent", "project_sales_member"), otherProject, options()), /Project access/);
  await assert.rejects(readCrmTeam(session(), foreignProject, options()), /Project access/);
  await db.admin.query("update project_pipeline_permissions set can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, colleague]);
  try { assert.ok(!(await readCrmTeam(session(), project, options())).members.some(member => member.id === colleague)); }
  finally { await db.admin.query("update project_pipeline_permissions set can_edit_deals=true where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, colleague]); }
  await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, agent]);
  try { await assert.rejects(readCrmTeam(session(agent, "agent", "project_sales_member"), project, options()), /Project access/); }
  finally { await db.admin.query("update project_pipeline_permissions set can_read=true where workspace_id=$1 and project_id=$2 and user_id=$3", [w, project, agent]); }
  await assert.rejects(readCrmTeam(session(suspended, "agent", "project_sales_member"), project, options()), /Active workspace membership/);
});

test("existing task persistence supports lead-context create, complete and a separate follow-on with version checks", async () => {
  const actor = session(agent, "agent", "project_sales_member");
  // The HTTP command wrapper already establishes this same authorized transaction context.
  const save = (task: Parameters<typeof upsertTaskRecord>[0]["task"], expectedVersion?: number) => withCrmRead(actor, (_tx, fresh) => upsertTaskRecord({ session: fresh, task, expectedVersion }, options()), options());
  const invalid = await save({ title: "SYNTHETIC invalid type", actionType: "unknown" as Task["actionType"],projectId:project,ownerUserId:agent });assert.equal(invalid.persisted,false);
  const first = await save({ actionType:"callback",title: "SYNTHETIC first task", projectId: project, leadId, contactId, ownerUserId: agent, due: "2026-11-05T08:00:00Z", status: "open", priority: "Normal" });
  assert.equal(first.persisted, true, first.persisted ? "" : first.reason); if (!first.persisted) return;
  assert.equal(first.data.actionType,"callback");
  const completed = await save({ ...first.data, status: "done" }, first.data.version);
  assert.equal(completed.persisted, true); if (!completed.persisted) return;
  assert.equal(completed.data.status, "done");
  assert.equal(completed.data.actionType,"callback");
  const stale = await save({ ...first.data, status: "done" }, first.data.version);
  assert.equal(stale.persisted, false);
  const next = await save({ title: "SYNTHETIC follow-on", projectId: project, leadId, contactId, ownerUserId: agent, due: "2026-11-06T08:00:00Z", status: "open", priority: "Normal" });
  assert.equal(next.persisted, true); if (!next.persisted) return;
  assert.notEqual(next.data.id, first.data.id);
  const selected = nextOpenTaskForLead([completed.data, next.data], { id: leadId, workspaceId: w, projectId: project });
  assert.equal(selected?.id, next.data.id);
  const persisted = await withCrmRead(actor, tx => tx.query<{ id: string; status: string }>("select id,status from tasks where workspace_id=$1::uuid and lead_id=$2::uuid order by id", [w, leadId]), options());
  assert.equal(persisted.length, 2); assert.deepEqual(new Set(persisted.map(task => task.status)), new Set(["open", "done"]));
});
