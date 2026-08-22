import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  botWebhookActorProductRoles,
  isEligibleBotWebhookActor,
  selectBotWebhookActor,
} from "../src/lib/bots/webhook-actor.ts";
import {
  buildPublicContactIdentityLocks,
  publicContactIdentityLockNamespace,
} from "../src/lib/security/public-contact-identity.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function botCrmBlock(runtime) {
  const start = runtime.indexOf("export async function upsertBotCrmEntities");
  const end = runtime.indexOf("export async function linkBotConversationToCrmEntities", start);
  assert.ok(start >= 0 && end > start, "Bot CRM persistence block must be present");
  return runtime.slice(start, end);
}

function webhookAccountLookupBlock(runtime) {
  const start = runtime.indexOf("export async function findBotChannelAccountForWebhook");
  const end = runtime.indexOf("export async function insertBotChannelWebhook", start);
  assert.ok(start >= 0 && end > start, "webhook channel-account lookup block must be present");
  return runtime.slice(start, end);
}

test("Bot, Form, Funnel and manual CRM writes share deterministic contact identity locks", async () => {
  const [forms, funnels, runtime, writes] = await Promise.all([
    source("src/lib/db/form-repositories.ts"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/lib/db/crm-write-repositories.ts"),
  ]);
  const bot = botCrmBlock(runtime);
  const canonical = buildPublicContactIdentityLocks({
    email: " shared@example.test ",
    fallback: "unused",
    phone: "+43 660 123 456",
  });
  const botVariant = buildPublicContactIdentityLocks({
    email: "SHARED@EXAMPLE.TEST",
    fallback: "different-fallback",
    phone: "+43(660)123-456",
  });

  assert.equal(publicContactIdentityLockNamespace, "public_contact_identity");
  assert.deepEqual(canonical, ["email:shared@example.test", "phone:+43660123456"]);
  assert.deepEqual(botVariant, canonical);
  for (const repository of [forms, funnels, writes, runtime]) {
    assert.match(repository, /publicContactIdentityLockNamespace/);
    assert.match(repository, /hashtextextended\(\$1::text \|\| ':' \|\| \$2::text \|\| ':' \|\| \$3::text/);
  }
  assert.match(bot, /const contactIdentityLocks = \[\.\.\.new Set\(\[/);
  assert.match(bot, /\]\)\]\.sort\(\)/);
  assert.match(bot, /\.\.\.\(contactRef \? \[`bot-ref:\$\{contactRef\}`\] : \[\]\)/);

  const firstLock = bot.indexOf("for (const contactIdentityLock of contactIdentityLocks)");
  const freshRead = bot.indexOf("const contactMatches = await transaction.query", firstLock);
  assert.ok(firstLock >= 0 && freshRead > firstLock, "identity locks must precede the fresh contact read");
  assert.match(bot.slice(firstLock, freshRead + 1_500), /archived_at is null/);
  assert.match(bot.slice(firstLock, freshRead + 1_500), /lower\(btrim\(email\)\) = \$2::text/);
  assert.match(bot.slice(firstLock, freshRead + 1_500), /regexp_replace\(coalesce\(phone, ''\), '\[\^0-9\+\]', '', 'g'\) = \$3::text/);
  assert.match(bot.slice(firstLock, freshRead + 1_500), /limit 2[\s\S]*for update/);
  assert.match(bot, /normalizedEmail !== existingNormalizedEmail/);
  assert.match(bot, /normalizedPhone !== existingNormalizedPhone/);
  assert.match(bot, /if \(contactIdentityConflict\) return null/);
});

test("the Bot CRM domain graph is tenant-validated and has no out-of-transaction writes", async () => {
  const [channelRoute, chatRoute, runtime, webhookRoute] = await Promise.all([
    source("src/app/api/bots/channels/route.ts"),
    source("src/app/api/bots/chat/route.ts"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/app/api/bots/channels/webhook/route.ts"),
  ]);
  const bot = botCrmBlock(runtime);
  const webhookAccountLookup = webhookAccountLookupBlock(runtime);
  const transactionStart = bot.indexOf("return withTenantTransaction(");

  assert.ok(transactionStart >= 0);
  assert.match(bot, /!isUuid\(input\.session\.userId\)/);
  assert.match(bot, /!input\.session\.permissions\.includes\("crm:write"\)/);
  assert.match(bot, /!canViewAllWorkspaceContacts\(input\.session\)/);
  assert.match(bot, /from workspace_users[\s\S]*workspace_id = \$1::uuid[\s\S]*id = \$2::uuid[\s\S]*status = 'active'[\s\S]*for share/);
  assert.match(bot, /from projects[\s\S]*workspace_id = \$1::uuid[\s\S]*id = \$2::uuid[\s\S]*for share/);
  assert.doesNotMatch(bot, /await queryOne(?:<|\()/);
  assert.doesNotMatch(bot, /await queryRows(?:<|\()/);
  assert.doesNotMatch(bot, /Promise\.all/);
  assert.match(bot, /writeAuditLog\(\{[\s\S]*transaction,/);
  assert.match(bot, /writeCrmAnalyticsEvent\(\{[\s\S]*transaction,/);
  assert.match(bot, /recordSpeedToLeadEvent\(\{[\s\S]*transaction,/);
  assert.match(bot, /if \(!contact\) throw new Error/);
  assert.match(bot, /if \(!lead\) throw new Error/);
  assert.match(bot, /if \(!timeline\) throw new Error/);
  assert.match(bot, /if \(!analyticsEventId\) throw new Error/);
  assert.match(bot, /if \(!speedToLeadEventId\) throw new Error/);
  assert.equal(bot.slice(0, transactionStart).includes("insert into contacts"), false);
  assert.match(channelRoute, /connectedByUserId: auth\.session\.userId/);
  assert.match(chatRoute, /requirePermission\(request, "bots:run"\)/);
  assert.match(chatRoute, /!auth\.session\.permissions\.includes\("crm:write"\)/);
  assert.match(chatRoute, /!canViewAllWorkspaceContacts\(auth\.session\)[\s\S]*status: 403/);
  assert.match(webhookAccountLookup, /webhook_actor\.id as "actorUserId"/);
  assert.match(webhookAccountLookup, /join lateral \([\s\S]*workspace_user\.product_role,[\s\S]*workspace_user\.role,[\s\S]*workspace_user\.status/);
  assert.match(webhookAccountLookup, /workspace_user\.workspace_id = bca\.workspace_id[\s\S]*workspace_user\.status = 'active'/);
  assert.match(webhookAccountLookup, /workspace_user\.role in \('owner', 'admin', 'agent'\)/);
  assert.match(webhookAccountLookup, /workspace_user\.product_role = any\(\$3::text\[\]\)/);
  assert.match(webhookAccountLookup, /workspace_user\.id::text = bca\.metadata->>'connectedByUserId'/);
  assert.match(webhookAccountLookup, /where bca\.active = true[\s\S]*bca\.setup_status in \('ready', 'connected'\)/);
  assert.doesNotMatch(webhookAccountLookup, /left join lateral/);
  assert.match(webhookRoute, /userId: channelAccount\.actorUserId/);
  assert.match(webhookRoute, /permissions: getRolePermissions\(channelAccount\.actorRole\)/);
  assert.match(webhookRoute, /productRole: channelAccount\.actorProductRole/);
  assert.match(webhookRoute, /role: channelAccount\.actorRole/);
  assert.match(webhookRoute, /botId: channelAccount\.botId/);
  assert.match(webhookRoute, /projectId: channelAccount\.projectId/);
  assert.doesNotMatch(webhookRoute, /userId: "bot-webhook"/);
  assert.doesNotMatch(webhookRoute, /productRole: "assistant_backoffice"|role: "assistant"/);

  const conversationInsert = runtime.slice(
    runtime.indexOf("export async function getOrCreateBotConversation"),
    runtime.indexOf("export async function listBotConversations"),
  );
  assert.match(conversationInsert, /from contacts where workspace_id = \$1[\s\S]*archived_at is null/);
  assert.match(conversationInsert, /from leads where workspace_id = \$1/);
  const conversationLink = runtime.slice(
    runtime.indexOf("export async function linkBotConversationToCrmEntities"),
    runtime.indexOf("export async function upsertBotChannelAccount"),
  );
  assert.match(conversationLink, /from contacts where workspace_id = \$2[\s\S]*from leads where workspace_id = \$2/);
  assert.match(await source("src/lib/bots/chat-runtime.ts"), /if \(!linkedConversationId\)[\s\S]*not available in this workspace/);
});

test("webhook actor selection rejects deactivated, viewer, partner and assistant identities", () => {
  const inactiveConnector = {
    id: "inactive-connector",
    productRole: "workspace_admin",
    role: "admin",
    status: "invited",
  };
  const activeViewer = {
    id: "active-viewer",
    productRole: "viewer",
    role: "agent",
    status: "active",
  };
  assert.equal(selectBotWebhookActor([inactiveConnector, activeViewer], inactiveConnector.id), null);
  assert.equal(isEligibleBotWebhookActor(activeViewer), false);
  assert.equal(isEligibleBotWebhookActor({
    id: "partner",
    productRole: "external_partner",
    role: "agent",
    status: "active",
  }), false);
  assert.equal(isEligibleBotWebhookActor({
    id: "assistant",
    productRole: "workspace_admin",
    role: "assistant",
    status: "active",
  }), false);

  const staff = {
    id: "valid-staff",
    productRole: "workspace_admin",
    role: "admin",
    status: "active",
  };
  assert.equal(selectBotWebhookActor([activeViewer, staff], activeViewer.id)?.id, staff.id);
  assert.equal(isEligibleBotWebhookActor(staff), true);
  assert.ok(botWebhookActorProductRoles.includes("workspace_admin"));
  assert.equal(botWebhookActorProductRoles.includes("viewer"), false);
});

async function importRuntimeForBehaviorTest() {
  const runtime = (await source("src/lib/db/runtime-repositories.ts"))
    .replace(/^import[\s\S]*?;\r?\n/gmu, "");
  const prelude = `
    const getHarness = () => globalThis.__novalureBotCrmHarness;
    const hasDatabaseUrl = () => true;
    const queryOne = async () => { getHarness().outsideWrites += 1; throw new Error("outside transaction queryOne"); };
    const queryRows = async () => { getHarness().outsideWrites += 1; throw new Error("outside transaction queryRows"); };
    const withTenantTransaction = (scope, callback) => getHarness().withTenantTransaction(scope, callback);
    const writeCrmAnalyticsEvent = async (input) => {
      if (!input.transaction) getHarness().missingTransactions += 1;
      const row = await input.transaction?.queryOne("insert into analytics_events /* bot_crm_test_analytics */ returning id", []);
      return row?.id ?? null;
    };
    const recordSpeedToLeadEvent = async (input) => {
      if (!input.transaction) getHarness().missingTransactions += 1;
      const row = await input.transaction?.queryOne("insert into speed_to_lead_events /* bot_crm_test_speed */ returning id", []);
      return row?.id ?? null;
    };
    const resolveCanonicalFunnelSubmissionSemantics = () => ({});
    const decryptSecret = () => "";
    const encryptSecret = () => "";
    const evaluateLaunchScope = () => ({ allowed: true });
    const hasProductCapability = () => false;
    const canViewAllWorkspaceContacts = (actor) =>
      actor.role === "owner" || actor.role === "admin" ||
      ["platform_admin", "customer_owner", "workspace_admin"].includes(actor.productRole);
    const normalizePublicContactEmail = (value) => value?.trim().toLowerCase() ?? "";
    const normalizePublicContactPhone = (value) => value?.replace(/[^0-9+]/gu, "") ?? "";
    const publicContactIdentityLockNamespace = "public_contact_identity";
    const buildPublicContactIdentityLocks = ({ email, fallback, phone }) => {
      const normalizedEmail = normalizePublicContactEmail(email);
      const normalizedPhone = normalizePublicContactPhone(phone);
      const locks = [
        normalizedEmail ? \`email:\${normalizedEmail}\` : "",
        normalizedPhone ? \`phone:\${normalizedPhone}\` : "",
      ].filter(Boolean).sort();
      return locks.length ? locks : [\`submission:\${fallback}\`];
    };
  `;
  const compiled = ts.transpileModule(prelude + runtime, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${randomUUID()}`);
}

function createState(patch = {}) {
  return {
    analytics: [],
    audits: [],
    contacts: [],
    leads: [],
    speedEvents: [],
    timelines: [],
    ...patch,
  };
}

function createHarness(initialState = createState()) {
  let committed = structuredClone(initialState);
  let serialTail = Promise.resolve();
  let nextId = 1;
  const harness = {
    commits: 0,
    failAt: "",
    missingTransactions: 0,
    outsideWrites: 0,
    rollbacks: 0,
    scopes: [],
    getState() {
      return structuredClone(committed);
    },
    async withTenantTransaction(scope, callback) {
      let release;
      const previous = serialTail;
      serialTail = new Promise((resolve) => { release = resolve; });
      await previous;
      const working = structuredClone(committed);
      harness.scopes.push({ ...scope });
      const makeId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
      const run = async (sql, params, many) => {
        const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
        let rows;
        if (normalized.includes("from workspace_users")) {
          rows = [{ id: params[1] }];
        } else if (normalized.includes("from projects")) {
          rows = [{ id: params[1] }];
        } else if (normalized.includes("insert into analytics_events")) {
          if (harness.failAt === "analytics") throw new Error("late analytics failure");
          const row = { id: makeId() };
          working.analytics.push(row);
          rows = [row];
        } else if (normalized.includes("insert into speed_to_lead_events")) {
          if (harness.failAt === "speed") throw new Error("late speed failure");
          const row = { id: makeId() };
          working.speedEvents.push(row);
          rows = [row];
        } else if (normalized.includes("insert into audit_logs")) {
          if (harness.failAt === "audit") throw new Error("late audit failure");
          const row = { id: makeId() };
          working.audits.push(row);
          rows = [row];
        } else if (normalized.startsWith("select") && normalized.includes("from contacts")) {
          const [, email, phone, contactRef] = params;
          rows = working.contacts
            .filter((contact) =>
              (email && contact.email?.trim().toLowerCase() === email) ||
              (phone && contact.phone?.replace(/[^0-9+]/gu, "") === phone) ||
              (contactRef && contact.metadata?.bot?.contactRef === contactRef))
            .slice(0, 2)
            .map((contact) => ({
              email: contact.email ?? null,
              id: contact.id,
              phone: contact.phone ?? null,
              projectId: contact.projectId ?? null,
            }));
        } else if (normalized.startsWith("update contacts")) {
          const contact = working.contacts.find((candidate) => candidate.id === params[1]);
          assert.ok(contact);
          contact.projectId = params[3] || contact.projectId || null;
          contact.name = params[4] || contact.name;
          contact.email = params[9] || contact.email || null;
          contact.phone = params[10] || contact.phone || null;
          contact.metadata = { ...(contact.metadata ?? {}), ...JSON.parse(params[11]) };
          rows = [{ email: contact.email, id: contact.id, phone: contact.phone, projectId: contact.projectId }];
        } else if (normalized.startsWith("insert into contacts")) {
          const contact = {
            email: params[8] || null,
            id: makeId(),
            metadata: JSON.parse(params[10]),
            name: params[3],
            phone: params[9] || null,
            projectId: params[1] || null,
            workspaceId: params[0],
          };
          working.contacts.push(contact);
          rows = [{ email: contact.email, id: contact.id, phone: contact.phone, projectId: contact.projectId }];
        } else if (normalized.startsWith("select") && normalized.includes("from leads")) {
          const lead = working.leads.find((candidate) =>
            candidate.workspaceId === params[0] &&
            candidate.contactId === params[1] &&
            candidate.source === params[2]);
          rows = lead ? [{ id: lead.id, projectId: lead.projectId ?? null }] : [];
        } else if (normalized.startsWith("update leads")) {
          const lead = working.leads.find((candidate) => candidate.id === params[1]);
          assert.ok(lead);
          lead.projectId = params[2] || lead.projectId || null;
          rows = [{ id: lead.id, projectId: lead.projectId }];
        } else if (normalized.startsWith("insert into leads")) {
          const lead = {
            contactId: params[2],
            id: makeId(),
            projectId: params[1] || null,
            source: params[3],
            workspaceId: params[0],
          };
          working.leads.push(lead);
          rows = [{ id: lead.id, projectId: lead.projectId }];
        } else if (normalized.startsWith("insert into contact_timeline_items")) {
          const row = { contactId: params[1], id: makeId(), leadId: JSON.parse(params[6]).leadId };
          working.timelines.push(row);
          rows = [row];
        } else {
          throw new Error(`Unhandled Bot CRM test query: ${normalized.slice(0, 120)}`);
        }
        return many ? rows : rows[0] ?? null;
      };
      const transaction = {
        async execute(sql) {
          assert.match(sql, /pg_advisory_xact_lock/);
        },
        query(sql, params = []) {
          return run(sql, params, true);
        },
        queryOne(sql, params = []) {
          return run(sql, params, false);
        },
      };

      try {
        const result = await callback(transaction);
        committed = working;
        harness.commits += 1;
        return result;
      } catch (error) {
        harness.rollbacks += 1;
        throw error;
      } finally {
        release();
      }
    },
  };
  return harness;
}

const workspaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const session = {
  permissions: ["bots:run", "crm:write"],
  productRole: "workspace_admin",
  role: "admin",
  userId: actorId,
  workspaceId,
};

function botInput(patch = {}) {
  return {
    channel: "WhatsApp",
    contactRef: "wa-contact-42",
    customerData: {
      email: "shared@example.test",
      name: "Shared Contact",
      phone: "+43 660 123 456",
    },
    projectId,
    prompt: "Ich interessiere mich für das Objekt",
    score: 80,
    session,
    ...patch,
  };
}

test("concurrent Bot writes converge and a Bot reuses a Form-created contact", async () => {
  const runtime = await importRuntimeForBehaviorTest();
  const harness = createHarness();
  globalThis.__novalureBotCrmHarness = harness;

  const [first, second] = await Promise.all([
    runtime.upsertBotCrmEntities(botInput()),
    runtime.upsertBotCrmEntities(botInput({
      customerData: {
        email: "SHARED@EXAMPLE.TEST",
        name: "Shared Contact",
        phone: "0043 (660) 123-456",
      },
    })),
  ]);
  const state = harness.getState();
  assert.equal(state.contacts.length, 1);
  assert.equal(state.leads.length, 1);
  assert.equal(state.timelines.length, 2);
  assert.equal(state.audits.length, 4);
  assert.equal(state.analytics.length, 1);
  assert.equal(state.speedEvents.length, 1);
  assert.equal(first.contactId, second.contactId);
  assert.equal(first.leadId, second.leadId);
  assert.equal([first, second].filter((result) => result.contactCreated).length, 1);
  assert.equal([first, second].filter((result) => result.leadCreated).length, 1);
  assert.equal(harness.outsideWrites, 0);
  assert.equal(harness.missingTransactions, 0);

  const formContactId = "44444444-4444-4444-8444-444444444444";
  const formHarness = createHarness(createState({
    contacts: [{
      email: "form-shared@example.test",
      id: formContactId,
      metadata: { createdFrom: "public_form" },
      name: "Form Contact",
      phone: "+43660111222",
      projectId,
      workspaceId,
    }],
  }));
  globalThis.__novalureBotCrmHarness = formHarness;
  const reused = await runtime.upsertBotCrmEntities(botInput({
    contactRef: "new-bot-ref",
    customerData: {
      email: " FORM-SHARED@EXAMPLE.TEST ",
      name: "Form Contact",
      phone: "+43 660 111 222",
    },
  }));
  assert.equal(reused.contactCreated, false);
  assert.equal(reused.contactId, formContactId);
  assert.equal(formHarness.getState().contacts.length, 1);
  assert.equal(formHarness.outsideWrites, 0);
});

test("Bot CRM rejects assistant, own-only and project-scoped sessions before opening a transaction", async () => {
  const runtime = await importRuntimeForBehaviorTest();
  for (const restrictedSession of [
    { ...session, permissions: ["bots:run"], productRole: "assistant_backoffice", role: "assistant" },
    { ...session, productRole: "broker_agent", role: "agent" },
    { ...session, productRole: "project_sales_member", role: "agent" },
  ]) {
    const harness = createHarness();
    globalThis.__novalureBotCrmHarness = harness;
    const result = await runtime.upsertBotCrmEntities(botInput({ session: restrictedSession }));
    assert.equal(result, null);
    assert.equal(harness.commits, 0);
    assert.equal(harness.scopes.length, 0);
    assert.deepEqual(harness.getState(), createState());
  }
});

test("Bot identity enrichment fails closed on contactRef/email and email/phone contradictions", async () => {
  const runtime = await importRuntimeForBehaviorTest();
  const existingId = "55555555-5555-4555-8555-555555555555";
  const initial = createState({
    contacts: [{
      email: "established@example.test",
      id: existingId,
      metadata: { bot: { contactRef: "established-ref" } },
      name: "Established Contact",
      phone: "+43660123456",
      projectId,
      workspaceId,
    }],
  });

  const contactRefHarness = createHarness(initial);
  globalThis.__novalureBotCrmHarness = contactRefHarness;
  const conflictingEmail = await runtime.upsertBotCrmEntities(botInput({
    contactRef: "established-ref",
    customerData: {
      email: "attacker@example.test",
      name: "Established Contact",
      phone: "+43 660 123 456",
    },
  }));
  assert.equal(conflictingEmail, null);
  assert.deepEqual(contactRefHarness.getState(), initial);

  const emailHarness = createHarness(initial);
  globalThis.__novalureBotCrmHarness = emailHarness;
  const conflictingPhone = await runtime.upsertBotCrmEntities(botInput({
    contactRef: null,
    customerData: {
      email: "ESTABLISHED@EXAMPLE.TEST",
      name: "Established Contact",
      phone: "+43 699 999 999",
    },
  }));
  assert.equal(conflictingPhone, null);
  assert.deepEqual(emailHarness.getState(), initial);
});

test("racing Bot identities on one contactRef create one identity and reject the contradictory writer", async () => {
  const runtime = await importRuntimeForBehaviorTest();
  const harness = createHarness();
  globalThis.__novalureBotCrmHarness = harness;

  const results = await Promise.all([
    runtime.upsertBotCrmEntities(botInput({
      contactRef: "shared-race-ref",
      customerData: {
        email: "race-first@example.test",
        name: "Race Contact",
        phone: null,
      },
    })),
    runtime.upsertBotCrmEntities(botInput({
      contactRef: "shared-race-ref",
      customerData: {
        email: "race-second@example.test",
        name: "Race Contact",
        phone: null,
      },
    })),
  ]);
  const state = harness.getState();
  assert.equal(state.contacts.length, 1);
  assert.equal(state.leads.length, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result?.contactCreated).length, 1);
  assert.ok(["race-first@example.test", "race-second@example.test"].includes(state.contacts[0].email));
  assert.equal(harness.outsideWrites, 0);
});

test("a late speed-to-lead failure rolls back contact, lead, timeline, audit and analytics", async () => {
  const runtime = await importRuntimeForBehaviorTest();
  const harness = createHarness();
  harness.failAt = "speed";
  globalThis.__novalureBotCrmHarness = harness;

  await assert.rejects(
    () => runtime.upsertBotCrmEntities(botInput({
      contactRef: "rollback-contact",
      customerData: {
        email: "rollback@example.test",
        name: "Rollback Contact",
        phone: "+43 660 999 888",
      },
    })),
    /late speed failure/,
  );
  assert.deepEqual(harness.getState(), createState());
  assert.equal(harness.commits, 0);
  assert.equal(harness.rollbacks, 1);
  assert.equal(harness.outsideWrites, 0);
  assert.equal(harness.missingTransactions, 0);
});
