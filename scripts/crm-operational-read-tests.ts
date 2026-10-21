import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions, type AppRole } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities, type ProductRole } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool, type TenantTransactionOptions } from "../src/lib/db/tenant-client";
import {
  readApprovalHistory,
  readBotActionHistory,
  readBotChannelHistory,
  readCalendarConnectionStatuses,
} from "../src/lib/db/crm-operational-readers";
import { seedDesignCIntegration, startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const canary = "SYNTHETIC_SECRET_MUST_NOT_LEAVE_DATABASE";
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const entryPoints = [
  ["crm_read_bot_channels", "uuid,uuid,uuid"],
  ["crm_read_bot_actions", "uuid,uuid,uuid"],
  ["crm_read_approvals", "uuid,uuid,uuid,text"],
  ["crm_read_calendar_connections", "uuid"],
] as const;
const rawTables = ["approval_requests", "bot_channel_webhooks", "bot_document_sends", "provider_connections"];

function persistedSession(input: {
  userId: string;
  workspaceId: string;
  authIdentityId?: string | null;
  role?: AppRole;
  productRole?: ProductRole;
}): AppSession {
  const role = input.role ?? "owner";
  const productRole = input.productRole ?? "customer_owner";
  return {
    authenticated: true, source: "database", userId: input.userId, workspaceId: input.workspaceId,
    ...(input.authIdentityId ? { authIdentityId: input.authIdentityId } : {}),
    workspaceName: "SYNTHETIC operational readers", name: "SYNTHETIC actor", email: "operational-reader@example.invalid",
    role, productRole, permissions: getRolePermissions(role), productPermissions: getProductRoleCapabilities(productRole),
  };
}

function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(canary), "untrusted configuration, payload, recipient/result and diagnostic canaries stay private");
  for (const key of ["accessToken", "refreshToken", "credentials", "replyAttemptToken", "processingResult", "customerData", "providerResult"]) {
    assert.ok(!serialized.includes(`\"${key}\"`), `${key} is not a client DTO field`);
  }
}

test("operational read DTOs use actual forced-RLS predecessors and an unprivileged runtime", { timeout: 240000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  const options: TenantTransactionOptions = { pool: db.pool as unknown as TenantPool };
  try {
    const fixture = await seedDesignCIntegration(db);
    const owner = persistedSession(fixture.customer);
    const viewer = persistedSession({ ...fixture.viewer, role: "assistant", productRole: "viewer" });
    const workspaceId = owner.workspaceId;
    const projectId = fixture.customer.projectId;
    const botId = fixture.customer.botId;
    const contactId = fixture.customer.contactId;
    const hiddenProjectId = randomUUID(), emptyProjectId = randomUUID(), hiddenBotId = randomUUID();
    const hiddenContactId = randomUUID(), ownerViewerId = randomUUID(), agentId = randomUUID();
    const conversationId = randomUUID(), hiddenConversationId = randomUUID();
    const channelAccountId = randomUUID(), webhookId = randomUUID(), documentSendId = randomUUID();
    const meetingId = randomUUID(), approvalId = randomUUID(), approvedId = randomUUID();
    const hiddenIds = { account: randomUUID(), webhook: randomUUID(), document: randomUUID(), meeting: randomUUID(), approval: randomUUID() };

    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'SYNTHETIC hidden history','Bauträger'),($2,$3,'SYNTHETIC empty history','Bauträger')", [hiddenProjectId, emptyProjectId, workspaceId]);
    await db.admin.query("insert into bots(id,workspace_id,project_id,name,role) values($1,$2,$3,'SYNTHETIC hidden bot','advisor')", [hiddenBotId, workspaceId, hiddenProjectId]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,email,role) values($1,$2,$3,'SYNTHETIC hidden recipient','hidden@example.invalid','Käufer')", [hiddenContactId, workspaceId, hiddenProjectId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$3,'SYNTHETIC owner viewer',$4,'owner','viewer','active'),($2,$3,'SYNTHETIC scoped agent',$5,'agent','project_sales_member','active')", [ownerViewerId, agentId, workspaceId, `owner-viewer-${ownerViewerId}@example.invalid`, `agent-${agentId}@example.invalid`]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false),($1,$2,$4,true,false)", [workspaceId, projectId, viewer.userId, agentId]);
    const ownerViewer = persistedSession({ userId: ownerViewerId, workspaceId, productRole: "viewer" });
    const agent = persistedSession({ userId: agentId, workspaceId, role: "agent", productRole: "project_sales_member" });

    async function seedHistory(input: {
      workspace: string; project: string; bot: string; contact: string; conversation: string;
      account: string; webhook: string; document: string; meeting: string; approval: string;
    }) {
      const toolCallId = randomUUID();
      await withTenantTransaction({ actorId: owner.userId, workspaceId: input.workspace }, async tx => {
        await tx.execute("insert into bot_conversations(id,workspace_id,project_id,bot_id,contact_id,title,metadata) values($1,$2,$3,$4,$5,'SYNTHETIC saved conversation','{\"channel\":\"webchat\"}'::jsonb)", [input.conversation, input.workspace, input.project, input.bot, input.contact]);
        await tx.execute("insert into bot_tool_calls(id,workspace_id,conversation_id,bot_id,tool_name) values($1,$2,$3,$4,'SYNTHETIC read fixture')", [toolCallId, input.workspace, input.conversation, input.bot]);
      }, options);
      await db.admin.query("insert into bot_channel_accounts(id,workspace_id,bot_id,channel,provider,account_label,setup_status,active,metadata) values($1,$2,$3,'webchat','synthetic','SYNTHETIC connected account','connected',true,$4::jsonb)", [input.account, input.workspace, input.bot, JSON.stringify({ credentials: { accessToken: canary }, providerResult: canary })]);
      await db.admin.query("insert into bot_channel_webhooks(id,workspace_id,channel_account_id,channel,event_type,payload,normalized_message,processing_result,reply_result,last_error,status) values($1,$2,$3,'webchat','message',$4::jsonb,$5::jsonb,$4::jsonb,$4::jsonb,$6,'received')", [input.webhook, input.workspace, input.account, JSON.stringify({ secret: canary }), JSON.stringify({ text: "SYNTHETIC customer message", accessToken: canary, botId: input.bot }), canary]);
      await db.admin.query("insert into bot_document_sends(id,workspace_id,bot_id,conversation_id,contact_id,channel,document_name,status,metadata) values($1,$2,$3,$4,$5,'webchat','SYNTHETIC brochure.pdf','ready_to_send',$6::jsonb)", [input.document, input.workspace, input.bot, input.conversation, input.contact, JSON.stringify({ customerData: { email: canary, name: canary }, providerResult: canary, attachedMediaAssetUrl: canary, documentDelivery: { errorCode: "provider_delivery_failed", recipient: canary, providerResult: canary } })]);
      await db.admin.query("insert into meeting_bookings(id,workspace_id,contact_id,slug,title,contact_name,contact_email,starts_at,ends_at,source,metadata) values($1,$2,$3,'synthetic-reader','SYNTHETIC viewing','SYNTHETIC saved recipient','recipient@example.invalid',now()+interval '1 day',now()+interval '1 day 30 minutes','bot',$4::jsonb)", [input.meeting, input.workspace, input.contact, JSON.stringify({ providerResult: canary, botId: input.bot, conversationId: input.conversation })]);
      await db.admin.query("insert into approval_requests(id,workspace_id,project_id,entity_type,entity_id,action,summary,payload) values($1,$2,$3,'bot_conversation',$4,'bot.write_actions.manual_override','SYNTHETIC approval',$5::jsonb)", [input.approval, input.workspace, input.project, input.conversation, JSON.stringify({ botName: "SYNTHETIC saved bot", channel: "webchat", prompt: "SYNTHETIC customer request", qualification: { score: 70, stage: "qualified", providerResult: canary }, requestedActions: { document: true, meeting: false, providerResult: canary }, toolCallIds: [toolCallId, randomUUID()], accessToken: canary, providerResult: canary })]);
    }
    await seedHistory({ workspace: workspaceId, project: projectId, bot: botId, contact: contactId, conversation: conversationId, account: channelAccountId, webhook: webhookId, document: documentSendId, meeting: meetingId, approval: approvalId });
    await seedHistory({ workspace: workspaceId, project: hiddenProjectId, bot: hiddenBotId, contact: hiddenContactId, conversation: hiddenConversationId, ...hiddenIds });
    await db.admin.query("insert into approval_requests(id,workspace_id,project_id,entity_type,entity_id,action,summary,status,payload) values($1,$2,$3,'bot_conversation',$4,'bot.write_actions.manual_override','SYNTHETIC approved item','approved','{}'::jsonb)", [approvedId, workspaceId, projectId, conversationId]);
    await db.admin.query("insert into provider_connections(workspace_id,provider,status,account_label,scopes,config,expires_at,error) values($1,'google-calendar','connected','SYNTHETIC calendar',array['calendar.read'], $2::jsonb,now()+interval '1 hour',$3)", [workspaceId, JSON.stringify({ accessToken: canary, refreshToken: canary, oauthState: canary }), canary]);

    await t.test("runtime identity remains non-owner, non-superuser and non-BYPASSRLS", async () => {
      const identity = (await db.pool.query("select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.equal(identity.role, db.role);
      assert.equal(identity.rolsuper, false);
      assert.equal(identity.rolbypassrls, false);
      assert.equal((await db.admin.query("select count(*)::int as count from novalure_schema_migrations where version='106_crm_operational_readers'")).rows[0].count, 1);
    });

    await t.test("saved nonempty history returns scoped DTOs and excludes configuration/payload secrets", async () => {
      const scope = { projectId, botId };
      const channels = await readBotChannelHistory(owner, scope, options);
      assert.deepEqual(channels.channelAccounts.map(row => row.id), [channelAccountId]);
      assert.deepEqual(channels.recentWebhookEvents.map(row => row.id), [webhookId]);
      assert.equal(channels.recentWebhookEvents[0].normalizedMessage?.text, "SYNTHETIC customer message");
      const actions = await readBotActionHistory(owner, { projectId }, options);
      assert.equal(actions.source, "database");
      assert.equal(actions.meetingBookingsAvailable, true);
      assert.deepEqual(actions.documentSends.map(row => row.id), [documentSendId]);
      assert.deepEqual(actions.meetingBookings.map(row => row.id), [meetingId]);
      const approvals = await readApprovalHistory(owner, scope, "pending", options);
      assert.equal(approvals.source, "database");
      assert.deepEqual(approvals.approvals.map(row => row.id), [approvalId]);
      assert.equal((approvals.approvals[0].payload.toolCallIds as unknown[]).length, 1, "only real tool rows are counted");
      assert.deepEqual((await readApprovalHistory(owner, scope, "approved", options)).approvals.map(row => row.id), [approvedId]);
      const calendar = await readCalendarConnectionStatuses(owner, options);
      assert.equal(calendar.google.connected, true);
      assert.equal(calendar.google.accountLabel, "SYNTHETIC calendar");
      assert.deepEqual(calendar.google.scopes, ["calendar.read"]);
      assert.equal(calendar.microsoft.connected, false);
      for (const value of [channels, actions, approvals, calendar]) assertNoSecrets(value);
    });

    await t.test("authorized empty project is database-backed empty; bot scope omits unbound meetings", async () => {
      const scope = { projectId: emptyProjectId };
      const channels = await readBotChannelHistory(owner, scope, options);
      assert.deepEqual(channels.channelAccounts, []);
      assert.deepEqual(channels.recentWebhookEvents, []);
      const actions = await readBotActionHistory(owner, scope, options);
      assert.equal(actions.source, "database");
      assert.deepEqual(actions.documentSends, []);
      assert.deepEqual(actions.meetingBookings, []);
      assert.deepEqual((await readApprovalHistory(owner, scope, "pending", options)).approvals, []);
      const botActions = await readBotActionHistory(owner, { botId }, options);
      assert.deepEqual(botActions.documentSends.map(row => row.id), [documentSendId]);
      assert.deepEqual(botActions.meetingBookings, []);
      assert.equal(botActions.meetingBookingsAvailable, false);
      assert.equal(botActions.metrics.openMeetings, null);
    });

    await t.test("original technical RBAC is preserved, including project-granted viewer reads", async () => {
      for (const actor of [viewer, agent]) {
        assert.deepEqual((await readBotChannelHistory(actor, {}, options)).recentWebhookEvents.map(row => row.id), [webhookId]);
        const actions = await readBotActionHistory(actor, {}, options);
        assert.deepEqual(actions.documentSends, [], "a project grant does not expose another actor's contact PII");
        assert.deepEqual(actions.meetingBookings, []);
        await db.admin.query("update contacts set owner_user_id=$2 where id=$1", [contactId, actor.userId]);
        try {
          const ownActions = await readBotActionHistory(actor, {}, options);
          assert.deepEqual(ownActions.documentSends.map(row => row.id), [documentSendId]);
          assert.deepEqual(ownActions.meetingBookings.map(row => row.id), [meetingId]);
        } finally { await db.admin.query("update contacts set owner_user_id=$2 where id=$1", [contactId, owner.userId]); }
        await assert.rejects(readApprovalHistory(actor, {}, "pending", options));
        await assert.rejects(readCalendarConnectionStatuses(actor, options));
      }
      assert.deepEqual((await readApprovalHistory(ownerViewer, { projectId }, "pending", options)).approvals.map(row => row.id), [approvalId], "technical owner keeps the existing approvals permission even with viewer product role");
      await assert.rejects(readCalendarConnectionStatuses(ownerViewer, options), "calendar still requires calendar:manage");
    });

    await t.test("mixed-tenant and conflicting saved relationships are omitted, not repaired from metadata", async () => {
      const foreignBot = (await db.admin.query("select id from bots where workspace_id=$1 limit 1", [fixture.foreign.workspaceId])).rows[0].id;
      const badAccount = randomUUID(), badWebhook = randomUUID();
      await db.admin.query("insert into bot_channel_accounts(id,workspace_id,bot_id,channel,provider,account_label) values($1,$2,$3,'webchat','synthetic',$4)", [badAccount, workspaceId, foreignBot, canary]);
      await db.admin.query("insert into bot_channel_webhooks(id,workspace_id,channel_account_id,channel,normalized_message) values($1,$2,$3,'webchat',$4::jsonb)", [badWebhook, workspaceId, badAccount, JSON.stringify({ text: canary, botId })]);
      for (const [badConversation, badContact] of [[hiddenConversationId, contactId], [conversationId, hiddenContactId], [conversationId, fixture.foreign.contactId]]) {
        await db.admin.query("insert into bot_document_sends(workspace_id,bot_id,conversation_id,contact_id,channel,document_name,metadata) values($1,$2,$3,$4,'webchat',$5,$6::jsonb)", [workspaceId, botId, badConversation, badContact, canary, JSON.stringify({ customerData: { name: canary }, projectId, botId })]);
      }
      await db.admin.query("insert into approval_requests(workspace_id,project_id,entity_type,entity_id,action,summary,payload) values($1,$2,'bot_conversation',$3,'bot.write_actions.manual_override',$4,$5::jsonb)", [workspaceId, projectId, hiddenConversationId, canary, JSON.stringify({ conversationId, botId, prompt: canary })]);
      const hiddenTool = (await db.admin.query("select id from bot_tool_calls where conversation_id=$1 limit 1", [hiddenConversationId])).rows[0].id;
      await db.admin.query("update approval_requests set payload=jsonb_set(payload,'{toolCallIds}',(payload->'toolCallIds')||to_jsonb($2::text)) where id=$1", [approvalId, hiddenTool]);
      const channels = await readBotChannelHistory(owner, { projectId }, options);
      assert.deepEqual(channels.channelAccounts.map(row => row.id), [channelAccountId]);
      assert.deepEqual(channels.recentWebhookEvents.map(row => row.id), [webhookId]);
      const actions = await readBotActionHistory(owner, { projectId }, options);
      assert.deepEqual(actions.documentSends.map(row => row.id), [documentSendId]);
      const approvals = await readApprovalHistory(owner, { projectId }, "pending", options);
      assert.deepEqual(approvals.approvals.map(row => row.id), [approvalId]);
      assert.equal((approvals.approvals[0].payload.toolCallIds as unknown[]).length, 1, "a hidden conversation's real tool ID cannot inflate this approval's tool history");
      for (const value of [channels, actions, approvals]) assertNoSecrets(value);
    });

    await t.test("foreign, ungranted, malformed and conflicting project/bot scopes cannot become workspace reads", async () => {
      const foreignBot = (await db.admin.query("select id from bots where workspace_id=$1 limit 1", [fixture.foreign.workspaceId])).rows[0].id;
      for (const scope of [
        { projectId: fixture.foreign.projectId }, { botId: foreignBot },
        { projectId, botId: hiddenBotId }, { projectId: hiddenProjectId, botId },
        { projectId: "invalid" }, { botId: "invalid" },
      ]) {
        await assert.rejects(readBotChannelHistory(owner, scope, options));
        await assert.rejects(readBotActionHistory(owner, scope, options));
        await assert.rejects(readApprovalHistory(owner, scope, "pending", options));
      }
      for (const read of [readBotChannelHistory, readBotActionHistory]) await assert.rejects(read(viewer, { projectId: hiddenProjectId }, options));
      await assert.rejects(readBotChannelHistory({ ...owner, workspaceId: fixture.foreign.workspaceId }, {}, options));
    });

    await t.test("fresh membership defeats stale client roles and inactive/service actors", async () => {
      const forgedOwner = { ...viewer, role: owner.role, productRole: owner.productRole, permissions: owner.permissions, productPermissions: owner.productPermissions };
      await assert.rejects(readApprovalHistory(forgedOwner, {}, "pending", options));
      await assert.rejects(readCalendarConnectionStatuses(forgedOwner, options));
      await db.admin.query("update workspace_users set status='invited' where id=$1", [viewer.userId]);
      try {
        await assert.rejects(readBotChannelHistory(viewer, {}, options));
        await assert.rejects(readBotActionHistory(viewer, {}, options));
      } finally { await db.admin.query("update workspace_users set status='active' where id=$1", [viewer.userId]); }
      const principal = (await db.admin.query("select p.workspace_id,p.actor_user_id,u.role,u.product_role from crm_service_principals p join workspace_users u on u.id=p.actor_user_id and u.workspace_id=p.workspace_id where p.identity_id='EVELYN_CRM_SERVICE_IDENTITY'")).rows[0];
      const service = persistedSession({ workspaceId: principal.workspace_id, userId: principal.actor_user_id, role: principal.role, productRole: principal.product_role });
      await assert.rejects(readBotChannelHistory(service, {}, options));
      await assert.rejects(readBotActionHistory(service, {}, options));
      await assert.rejects(readApprovalHistory(service, {}, "pending", options));
      await assert.rejects(readCalendarConnectionStatuses(service, options));
    });

    await t.test("raw tables remain inaccessible and no write privileges are added", async () => {
      for (const table of rawTables) {
        const privileges = (await db.pool.query("select has_table_privilege(current_user,$1,'SELECT') as read,has_table_privilege(current_user,$1,'INSERT') as insert,has_table_privilege(current_user,$1,'UPDATE') as update,has_table_privilege(current_user,$1,'DELETE') as delete", [`public.${table}`])).rows[0];
        assert.deepEqual(privileges, { read: false, insert: false, update: false, delete: false }, table);
        await assert.rejects(db.pool.query(`select * from public.${table} limit 1`), sqlCode("42501"));
      }
      const before = (await db.admin.query("select count(*)::int as count from provider_connections where workspace_id=$1", [workspaceId])).rows[0].count;
      await readCalendarConnectionStatuses(owner, options);
      assert.equal((await db.admin.query("select count(*)::int as count from provider_connections where workspace_id=$1", [workspaceId])).rows[0].count, before);
      for (const [name, argumentsList] of entryPoints) {
        const privileges = (await db.pool.query("select has_function_privilege(current_user,$1,'EXECUTE') as runtime,exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as public", [`public.${name}(${argumentsList})`])).rows[0];
        assert.equal(privileges.runtime, true, name);
        assert.equal(privileges.public, false, name);
      }
    });

    await t.test("SQL entry points independently reject unset or mismatched context", async () => {
      for (const [name] of entryPoints) {
        const sql = name === "crm_read_calendar_connections" ? `select public.${name}($1::uuid)`
          : name === "crm_read_approvals" ? `select public.${name}($1::uuid,null::uuid,null::uuid,'pending')`
            : `select public.${name}($1::uuid,null::uuid,null::uuid)`;
        await assert.rejects(db.pool.query(sql, [workspaceId]), sqlCode("42501"));
        await assert.rejects(withTenantTransaction({ actorId: owner.userId, workspaceId }, tx => tx.query(sql, [fixture.foreign.workspaceId]), options), sqlCode("42501"));
      }
      await db.admin.query("update workspace_users set product_role=null where id=$1", [ownerViewerId]);
      try {
        await assert.rejects(withTenantTransaction({ actorId: ownerViewerId, workspaceId }, tx => tx.query("select public.crm_read_bot_channels($1::uuid,null::uuid,null::uuid)", [workspaceId]), options), sqlCode("42501"));
      } finally { await db.admin.query("update workspace_users set product_role='viewer' where id=$1", [ownerViewerId]); }
      await assert.rejects(db.pool.query("select public.crm_operational_assert_scope($1::uuid,null::uuid,null::uuid,'bots:run')", [workspaceId]), sqlCode("42501"));
    });

    await t.test("a missing reader function remains a failed source and transactional rollback restores it", async () => {
      // DDL is isolated inside one rollback-only local admin transaction. The
      // application callback executes after SET ROLE to the actual runtime.
      // A savepoint adapter keeps withTenantTransaction's BEGIN/ROLLBACK local
      // to that callback, so the uncommitted DROP is visible without publishing
      // a missing function to other connections or granting any permissions.
      const client = await db.admin.connect();
      try {
        await client.query("begin");
        await client.query("drop function public.crm_read_bot_channels(uuid,uuid,uuid)");
        assert.match(db.role, /^[a-z0-9_]+$/);
        await client.query(`set local role ${db.role}`);
        const pinned = {
          async query(sql: string, params?: unknown[]) {
            if (sql === "begin") return client.query("savepoint operational_reader_failure");
            if (sql === "commit") {
              const result = await client.query("release savepoint operational_reader_failure");
              return { ...result, command: "COMMIT" };
            }
            if (sql === "rollback") {
              await client.query("rollback to savepoint operational_reader_failure");
              return client.query("release savepoint operational_reader_failure");
            }
            return client.query(sql, params);
          },
          release() {},
        } as unknown as Awaited<ReturnType<TenantPool["connect"]>>;
        const failureOptions: TenantTransactionOptions = { pool: { async connect() { return pinned; } } };
        await assert.rejects(readBotChannelHistory(owner, { projectId }, failureOptions), sqlCode("42883"));
      } finally {
        await client.query("rollback");
        client.release();
      }
      assert.deepEqual((await readBotChannelHistory(owner, { projectId }, options)).recentWebhookEvents.map(row => row.id), [webhookId]);
    });

    await t.test("call-insight and workflow approvals preserve valid models and reject foreign or mismatched links", async () => {
      const ownLead = randomUUID(), hiddenLead = randomUUID(), foreignLead = randomUUID();
      for (const [id, workspace, project, contact] of [
        [ownLead, workspaceId, projectId, contactId],
        [hiddenLead, workspaceId, hiddenProjectId, hiddenContactId],
        [foreignLead, fixture.foreign.workspaceId, fixture.foreign.projectId, fixture.foreign.contactId],
      ]) {
        await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,type) values($1,$2,$3,$4,'Käufer')", [id, workspace, project, contact]);
      }
      const globalWorkflow = randomUUID(), projectWorkflow = randomUUID(), hiddenWorkflow = randomUUID(), foreignWorkflow = randomUUID();
      for (const [id, workspace, project] of [
        [globalWorkflow, workspaceId, null], [projectWorkflow, workspaceId, projectId],
        [hiddenWorkflow, workspaceId, hiddenProjectId],
        [foreignWorkflow, fixture.foreign.workspaceId, fixture.foreign.projectId],
      ]) {
        await db.admin.query("insert into lead_workflows(id,workspace_id,project_id,name) values($1,$2,$3,'SYNTHETIC approval workflow')", [id, workspace, project]);
      }
      const accepted = [approvalId];
      async function approval(entityType: "call_insight" | "lead_workflow_run", entityId: string, valid: boolean) {
        const id = randomUUID();
        await db.admin.query("insert into approval_requests(id,workspace_id,project_id,entity_type,entity_id,action,summary,payload) values($1,$2,$3,$4,$5,'manual_review',$6,$7::jsonb)", [id, workspaceId, projectId, entityType, entityId, valid ? "SYNTHETIC valid linked approval" : canary, JSON.stringify({ prompt: valid ? "SYNTHETIC review request" : canary, providerResult: canary })]);
        if (valid) accepted.push(id);
      }
      for (const [workspace, project, workflow, lead, valid] of [
        [workspaceId, projectId, globalWorkflow, ownLead, true],
        [workspaceId, projectId, projectWorkflow, ownLead, true],
        [workspaceId, projectId, hiddenWorkflow, ownLead, false],
        [workspaceId, projectId, foreignWorkflow, ownLead, false],
        [workspaceId, projectId, globalWorkflow, foreignLead, false],
        [workspaceId, projectId, globalWorkflow, hiddenLead, false],
        [workspaceId, hiddenProjectId, hiddenWorkflow, hiddenLead, false],
        [fixture.foreign.workspaceId, fixture.foreign.projectId, foreignWorkflow, foreignLead, false],
      ] as const) {
        const run = randomUUID();
        await db.admin.query("insert into lead_workflow_runs(id,workspace_id,project_id,workflow_id,lead_id,input,result) values($1,$2,$3,$4,$5,$6::jsonb,$6::jsonb)", [run, workspace, project, workflow, lead, JSON.stringify({ diagnostic: canary })]);
        await approval("lead_workflow_run", run, valid);
      }
      for (const [workspace, project, contact, lead, valid] of [
        [workspaceId, projectId, contactId, ownLead, true],
        [workspaceId, projectId, fixture.foreign.contactId, ownLead, false],
        [workspaceId, projectId, hiddenContactId, ownLead, false],
        [workspaceId, projectId, contactId, foreignLead, false],
        [workspaceId, projectId, contactId, hiddenLead, false],
        [workspaceId, hiddenProjectId, hiddenContactId, hiddenLead, false],
        [fixture.foreign.workspaceId, fixture.foreign.projectId, fixture.foreign.contactId, foreignLead, false],
      ] as const) {
        const insight = randomUUID();
        await db.admin.query("insert into call_insights(id,workspace_id,project_id,contact_id,lead_id,transcript,metadata) values($1,$2,$3,$4,$5,$6,$7::jsonb)", [insight, workspace, project, contact, lead, canary, JSON.stringify({ diagnostic: canary })]);
        await approval("call_insight", insight, valid);
      }
      const snapshot = await readApprovalHistory(owner, { projectId }, "pending", options);
      assert.deepEqual(snapshot.approvals.map(row => row.id).sort(), accepted.sort());
      assertNoSecrets(snapshot);
      assert.deepEqual((await readApprovalHistory(owner, { projectId, botId }, "pending", options)).approvals.map(row => row.id), [approvalId], "non-bot models do not acquire a bot relation from their shared project");
      assert.equal((await readCalendarConnectionStatuses(owner, options)).source, "database");
    });
  } finally { await db.stop(); }
});
