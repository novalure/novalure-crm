import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { currentTenantTransaction } from "../src/lib/db/transaction-context";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { defaultCrmNotificationEmailPreferences, nextCrmNotificationEmailAt, parseCrmNotificationEmailPreferences, renderCrmNotificationEmail } from "../src/lib/crm-notification-email";
import { configuredCrmNotificationEmailScopes, crmNotificationEmailConfiguration } from "../src/lib/crm-notification-email-configuration";
import { claimCrmNotificationEmail, loadCrmNotificationEmail, prepareCrmNotificationEmail, retryCrmNotificationEmail, saveCrmNotificationEmail } from "../src/lib/db/crm-notification-email-repository";
import { handleCrmNotificationEmailCron, processCrmNotificationEmail } from "../src/lib/crm-notification-email-worker";
import { prepareCrmNotificationDigest } from "../src/lib/db/crm-notifications-repository";
import type { NewsletterDispatch } from "../src/lib/newsletter-provider";

test("digest schedule respects country timezones, weekly Monday and daylight-saving gaps/repeated hours", () => {
  const prefs = defaultCrmNotificationEmailPreferences();
  assert.equal(prefs.enabled, false); assert.throws(() => parseCrmNotificationEmailPreferences({ ...prefs, recipient: "other@example.invalid" }));
  assert.equal(nextCrmNotificationEmailAt(prefs, new Date("2026-11-04T06:59:59Z")), "2026-11-04T07:00:00.000Z");
  assert.equal(nextCrmNotificationEmailAt({ ...prefs, timeZone: "Europe/Dublin" }, new Date("2026-11-04T06:59:59Z")), "2026-11-04T08:00:00.000Z");
  assert.equal(nextCrmNotificationEmailAt({ ...prefs, frequency: "weekly" }, new Date("2026-11-04T06:00:00Z")), "2026-11-09T07:00:00.000Z");
  assert.equal(nextCrmNotificationEmailAt({ ...prefs, hour: 2 }, new Date("2026-03-29T00:15:00Z")), "2026-03-30T00:00:00.000Z", "nonexistent local hour is skipped");
  assert.equal(nextCrmNotificationEmailAt({ ...prefs, hour: 2 }, new Date("2026-10-25T00:15:00Z")), "2026-10-26T01:00:00.000Z", "the repeated hour cannot create a second daily check");
  const rendered = renderCrmNotificationEmail({ new_lead: 2, task_due: 1 }, "es", "https://crm.example.invalid/"); assert.match(rendered.subject, /3 avisos/); assert.match(rendered.html, /lang="es"/); assert.doesNotMatch(rendered.html, /<script|unsubscribe\?|pixel|utm_/i);
  assert.throws(() => renderCrmNotificationEmail({}, "de", "https://crm.example.invalid")); assert.throws(() => renderCrmNotificationEmail({ task_due: 1 }, "de", "https://crm.example.invalid?token=secret"));
});
test("digest configuration requires authenticated cron, explicit account scopes and an actual configured sender", () => {
  const scope = { workspaceId: randomUUID(), actorId: randomUUID() };
  assert.equal(crmNotificationEmailConfiguration(scope, { NODE_ENV: "test" }).ready, false);
  assert.throws(() => configuredCrmNotificationEmailScopes({ NODE_ENV: "test", NOVALURE_NOTIFICATION_DIGEST_SCOPES: JSON.stringify([{ ...scope, projectId: randomUUID() }]) }));
  assert.throws(() => configuredCrmNotificationEmailScopes({ NODE_ENV: "test", NOVALURE_NOTIFICATION_DIGEST_SCOPES: JSON.stringify([scope, scope]) }));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CRON_SECRET: "synthetic-cron", RESEND_API_KEY: "synthetic-never-used", RESEND_FROM: "Notifications <notifications@example.invalid>", NOVALURE_APP_ORIGIN: "https://crm.example.invalid", NOVALURE_NOTIFICATION_DIGEST_SCOPES: JSON.stringify([scope]) };
  assert.equal(crmNotificationEmailConfiguration(scope, env).ready, true); assert.equal(crmNotificationEmailConfiguration(scope, { ...env, RESEND_FROM: "onboarding@resend.dev" }).ready, false); assert.equal(crmNotificationEmailConfiguration({ ...scope, actorId: randomUUID() }, env).ready, false);
});
test("personal email digests use durable claims and coverage with synthetic providers only", { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 });
    for (const file of ["161_crm_notification_preferences.sql", "177_crm_notification_email.sql"]) await db.admin.query(await readFile(`migrations/${file}`, "utf8"));
    const workspaceId = randomUUID(), actorId = randomUUID(), otherId = randomUUID(), projectId = randomUUID(), scope = { workspaceId, actorId };
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC digest','self_service_customer','real_estate_broker')", [workspaceId]);
    for (const id of [actorId, otherId]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,'owner','customer_owner','active')", [id, workspaceId, `${id}@example.invalid`]);
    await db.admin.query("update auth_identities set credential_state='active',password_hash='synthetic-unusable' where id in(select auth_identity_id from workspace_users where workspace_id=$1)", [workspaceId]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC digest project','Service')", [projectId, workspaceId]);
    const session = { authenticated: true, userId: actorId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `${actorId}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "database" } as AppSession, other = { ...session, userId: otherId };
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CRON_SECRET: "synthetic-cron-secret", RESEND_API_KEY: "synthetic-provider-not-used", RESEND_FROM: "Notifications <notifications@example.invalid>", NOVALURE_APP_ORIGIN: "https://crm.example.invalid/", NOVALURE_NOTIFICATION_DIGEST_SCOPES: JSON.stringify([scope]) };
    const options = { pool: db.pool as unknown as TenantPool, env }, run = <T>(work: (tx: TenantTransaction, fresh: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    const due = async () => { await db.admin.query("update crm_notification_email_settings set next_run_at=now()-interval '1 minute' where workspace_id=$1 and user_id=$2", [workspaceId, actorId]); };
    const task = async (title = "PRIVATE customer detail must stay inside CRM", metadata = {}) => { const id = randomUUID(); await db.admin.query("insert into tasks(id,workspace_id,project_id,owner_user_id,title,due_at,status,metadata) values($1,$2,$3,$4,$5,now(),'open',$6::jsonb)", [id, workspaceId, projectId, actorId, title, JSON.stringify(metadata)]); return id; };
    const sent: NewsletterDispatch[] = [], accepted = async (message: NewsletterDispatch) => { assert.equal(currentTenantTransaction(), undefined, "network transport runs after the database transaction has committed"); sent.push(message); assert.equal((await db.admin.query("select status from crm_notification_email_jobs where id=$1", [message.idempotencyKey.split("/")[1]])).rows[0].status, "dispatching"); return { status: "accepted" as const, messageId: `synthetic-${sent.length}` }; };
    let revision = 0, preferences = { ...defaultCrmNotificationEmailPreferences(), enabled: true, projectId };
    await t.test("opt-in binds only the current login address and stores personal settings with CAS and replay", async () => {
      const before = await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options)); assert.equal(before.preferences.enabled, false); assert.equal(before.identityReady, true);
      const requestId = randomUUID(), first = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, preferences, 0, requestId)); revision = first.revision;
      const replay = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, preferences, 0, requestId)); assert.equal(replay.replayed, true);
      await assert.rejects(run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, { ...preferences, hour: 9 }, 0, randomUUID())));
      assert.equal((await run(tx => tx.query("select * from crm_notification_email_settings"), other)).length, 0);
      assert.equal((await run(tx => tx.queryOne<{ identity: unknown }>("select crm_notification_email_identity($1::uuid,$2::uuid) as identity", [workspaceId, actorId]), other))?.identity, null);
    });
    await t.test("two workers send one real claimed count-only payload and unchanged/empty data stays quiet", async () => {
      await task(); await task("SYNTHETIC excluded sample", { onboardingExample: { synthetic: true } });
      const inApp = await run((tx, fresh) => prepareCrmNotificationDigest(tx, fresh, projectId, randomUUID())); assert.equal("count" in inApp && inApp.count, 1, "manual in-app preparation does not consume email coverage");
      await due(); const outcomes = await Promise.all([processCrmNotificationEmail(scope, { ...options, transport: accepted }), processCrmNotificationEmail(scope, { ...options, transport: accepted })]);
      assert.equal(sent.length, 1); assert.ok(outcomes.some(outcome => outcome.status === "accepted")); assert.doesNotMatch(sent[0].html, /PRIVATE|customer detail|SYNTHETIC excluded|example\.invalid.*task/i); assert.match(sent[0].html, /Fällige Aufgaben: 1/);
      assert.equal(sent[0].to, session.email); assert.equal((await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options))).jobs[0].status, "accepted");
      await due(); assert.equal((await processCrmNotificationEmail(scope, { ...options, transport: accepted })).status, "quiet"); assert.equal(sent.length, 1);
    });
    await t.test("definite rejection supports a bounded explicit retry with the same provider key and immutable content", async () => {
      await task("PRIVATE retry"); await due();
      const rejected: NewsletterDispatch[] = []; const first = await processCrmNotificationEmail(scope, { ...options, transport: async message => { rejected.push(message); return { status: "failed", error: "synthetic rejected" }; } }); assert.equal(first.status, "failed");
      const state = await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options)), failed = state.jobs.find(job => job.status === "failed")!; assert.equal(failed.retryAllowed, true);
      await assert.rejects(run(tx => tx.query("update crm_notification_email_jobs set payload='{}',revision=revision+1 where id=$1::uuid", [failed.id])));
      await run((tx, fresh) => retryCrmNotificationEmail(tx, fresh, failed.id, failed.revision)); const repeat = await run((tx, fresh) => retryCrmNotificationEmail(tx, fresh, failed.id, failed.revision)); assert.equal(repeat.replayed, true);
      await processCrmNotificationEmail(scope, { ...options, transport: accepted }); assert.deepEqual(sent.at(-1), rejected[0]);
    });
    await t.test("unknown provider outcome and expired durable claim are never automatically replayed", async () => {
      await task("PRIVATE uncertain"); await due(); let calls = 0;
      const result = await processCrmNotificationEmail(scope, { ...options, transport: async () => { calls++; throw new Error("synthetic timeout after possible acceptance"); } }); assert.equal(result.status, "uncertain");
      await due(); await processCrmNotificationEmail(scope, { ...options, transport: accepted }); assert.equal(calls, 1);
      const uncertain = (await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options))).jobs.find(job => job.status === "uncertain")!; assert.equal(uncertain.retryAllowed, false); await assert.rejects(run((tx, fresh) => retryCrmNotificationEmail(tx, fresh, uncertain.id, uncertain.revision)));
      await task("PRIVATE crash"); await due(); const prepared = await run((tx, fresh) => prepareCrmNotificationEmail(tx, fresh, options)); assert.ok("id" in prepared && prepared.id);
      const claim = await run((tx, fresh) => claimCrmNotificationEmail(tx, fresh, prepared.id!, options)); assert.ok(claim);
      await db.admin.query("alter table crm_notification_email_jobs disable trigger crm_notification_email_job_guard");
      try { await db.admin.query("update crm_notification_email_jobs set lease_until=now()-interval '1 minute' where id=$1", [claim.id]); } finally { await db.admin.query("alter table crm_notification_email_jobs enable trigger crm_notification_email_job_guard"); }
      await processCrmNotificationEmail(scope, { ...options, transport: accepted }); assert.equal((await db.admin.query("select status,error from crm_notification_email_jobs where id=$1", [claim.id])).rows[0].status, "uncertain");
    });
    await t.test("disabling or reading a pending source suppresses the job and releases only its unsent coverage", async () => {
      const id = await task("PRIVATE cancel"); await due(); const prepared = await run((tx, fresh) => prepareCrmNotificationEmail(tx, fresh, options)); assert.ok("id" in prepared && prepared.id);
      preferences = { ...preferences, enabled: false }; const saved = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, preferences, revision, randomUUID())); revision = saved.revision;
      assert.equal((await db.admin.query("select status from crm_notification_email_jobs where id=$1", [prepared.id])).rows[0].status, "suppressed");
      assert.equal(Number((await db.admin.query("select count(*) from crm_notification_email_coverage where job_id=$1", [prepared.id])).rows[0].count), 0);
      preferences = { ...preferences, enabled: true }; const enabled = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, preferences, revision, randomUUID())); revision = enabled.revision; await due(); const second = await run((tx, fresh) => prepareCrmNotificationEmail(tx, fresh, options)); assert.ok("id" in second && second.id);
      await db.admin.query("update tasks set status='done' where id=$1", [id]); assert.equal(await run((tx, fresh) => claimCrmNotificationEmail(tx, fresh, second.id!, options)), null); assert.equal((await db.admin.query("select status from crm_notification_email_jobs where id=$1", [second.id])).rows[0].status, "suppressed");
    });
    await t.test("a project grant revoked after preparation suppresses the pending message before transport", async () => {
      await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)", [workspaceId, projectId, actorId]);
      await db.admin.query("update workspace_users set role='agent',product_role='broker_agent' where id=$1", [actorId]);
      await task("PRIVATE project revoked"); await due(); const prepared = await run((tx, fresh) => prepareCrmNotificationEmail(tx, fresh, options)); assert.ok("id" in prepared && prepared.id);
      await db.admin.query("update project_pipeline_permissions set can_read=false where workspace_id=$1 and project_id=$2 and user_id=$3", [workspaceId, projectId, actorId]);
      const result = await processCrmNotificationEmail(scope, { ...options, transport: async () => { throw new Error("must not send after revoked project access"); } }); assert.equal(result.status, "quiet");
      assert.equal((await db.admin.query("select status,error from crm_notification_email_jobs where id=$1", [prepared.id])).rows[0].error, "project_access_revoked");
      const disabled = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, { ...preferences, enabled: false }, revision, randomUUID())); revision = disabled.revision;
      assert.equal((await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options))).preferences.enabled, false, "personal opt-out remains possible after project rights are revoked");
      await db.admin.query("update workspace_users set role='owner',product_role='customer_owner' where id=$1", [actorId]);
      const restored = await run((tx, fresh) => saveCrmNotificationEmail(tx, fresh, preferences, revision, randomUUID())); revision = restored.revision;
    });
    await t.test("the narrow identity reader works with a real non-BYPASS function/table owner and cannot inspect another actor", async () => {
      await db.admin.query("create role qa_digest_definer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public to qa_digest_definer; grant select on auth_identities to qa_digest_definer; alter table workspace_users owner to qa_digest_definer; alter function crm_notification_email_identity(uuid,uuid) owner to qa_digest_definer");
      try {
        const own = await run((tx, fresh) => loadCrmNotificationEmail(tx, fresh, options)); assert.equal(own.identityReady, true); assert.equal(own.recipient, session.email);
        assert.equal((await run(tx => tx.queryOne<{ identity: unknown }>("select crm_notification_email_identity($1::uuid,$2::uuid) as identity", [workspaceId, otherId])))?.identity, null);
        await assert.rejects(run(tx => tx.query("delete from crm_notification_email_coverage where workspace_id=$1::uuid and user_id=$2::uuid", [workspaceId, actorId])), /coverage cannot/);
      } finally { await db.admin.query("alter function crm_notification_email_identity(uuid,uuid) owner to qa_admin; alter table workspace_users owner to qa_admin"); }
    });
    await t.test("revoked identities and missing server account configuration cause zero transport calls", async () => {
      let calls = 0; const transport = async () => { calls++; return { status: "accepted" as const, messageId: "must-not-send" }; };
      const notConfigured = await processCrmNotificationEmail(scope, { ...options, env: { ...env, NOVALURE_NOTIFICATION_DIGEST_SCOPES: "[]" }, transport }); assert.equal(notConfigured.status, "blocked");
      await db.admin.query("update auth_identities set credential_state='disabled',disabled_at=now() where id=(select auth_identity_id from workspace_users where id=$1)", [actorId]); await due(); const blocked = await processCrmNotificationEmail(scope, { ...options, transport }); assert.equal(blocked.status, "quiet"); assert.equal(calls, 0);
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [actorId]); await assert.rejects(processCrmNotificationEmail(scope, { ...options, transport })); assert.equal(calls, 0);
    });
    await t.test("cron cannot be triggered without its bearer secret or with caller-supplied scope overrides", async () => {
      const transport = async () => { throw new Error("must not be called"); };
      assert.equal((await handleCrmNotificationEmailCron(new Request("https://crm.example.invalid/api/cron/notification-digests"), env, { ...options, transport })).status, 401);
      assert.equal((await handleCrmNotificationEmailCron(new Request("https://crm.example.invalid/api/cron/notification-digests?workspaceId=other", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }), env, { ...options, transport })).status, 401);
      const paused = await handleCrmNotificationEmailCron(new Request("https://crm.example.invalid/api/cron/notification-digests", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }), { ...env, NOVALURE_WORKERS_PAUSED: "1" }, { ...options, transport }); assert.equal(paused.status, 200); assert.equal((await paused.json()).paused, true);
    });
  } finally { await db.stop(); }
});
