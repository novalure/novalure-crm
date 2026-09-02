import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherUserId = "33333333-3333-4333-8333-333333333333";
const projectA = "44444444-4444-4444-8444-444444444444";
const projectB = "55555555-5555-4555-8555-555555555555";
const propertyId = "66666666-6666-4666-8666-666666666666";
const leadId = "77777777-7777-4777-8777-777777777777";
const contactId = "88888888-8888-4888-8888-888888888888";
const unitId = "99999999-9999-4999-8999-999999999999";

const repositorySource = await readFile(
  new URL("../src/lib/db/property-department-repositories.ts", import.meta.url),
  "utf8",
);

function normalizeSql(query) {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function baseSession(overrides = {}) {
  return {
    permissions: ["crm:read", "crm:write"],
    productRole: "broker_agent",
    role: "agent",
    userId: actorId,
    workspaceId,
    ...overrides,
  };
}

function baseListing(overrides = {}) {
  return {
    address: "Musterstraße 1",
    areaSqm: 70,
    canonicalPayload: {},
    channelPriceVisibility: {},
    costsSummary: {},
    createdAt: "2026-09-02T08:00:00.000Z",
    documentSummary: {},
    id: propertyId,
    marketValueCents: 40000000,
    mediaSummary: {},
    objectType: "Wohnung",
    ownerContactId: null,
    ownerUserId: otherUserId,
    priceVisibility: "publish_price",
    projectId: projectA,
    region: "Wien",
    sellerLeadId: null,
    targetPriceCents: 40000000,
    textSummary: {},
    title: "Testobjekt",
    unitId,
    workspaceId,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const state = { audits: 0, mutations: [], queries: [], transactions: 0 };
  const listing = baseListing(options.listing);
  const grantProjects = new Set(options.grantProjects ?? []);
  const projects = new Set(options.projects ?? [projectA, projectB]);
  const workspaceUsers = new Set(options.workspaceUsers ?? [actorId, otherUserId]);
  const transaction = {
    async execute(query, params = []) {
      const sql = normalizeSql(query);
      state.queries.push({ params: [...params], sql });
      if (/^(delete|insert|update)\b/.test(sql)) state.mutations.push(sql);
    },
    async query() {
      return [];
    },
    async queryOne(query, params = []) {
      const sql = normalizeSql(query);
      state.queries.push({ params: [...params], sql });
      if (/^(delete|insert|update)\b/.test(sql)) state.mutations.push(sql);

      if (sql.includes("from seller_listings") && sql.includes("for update")) {
        return options.missingListing ? null : {
          id: listing.id,
          ownerContactId: listing.ownerContactId,
          ownerUserId: listing.ownerUserId,
          projectId: listing.projectId,
          sellerLeadId: listing.sellerLeadId,
        };
      }
      if (sql.includes("from project_pipeline_permissions")) {
        return grantProjects.has(params[1]) ? { canEditDeals: true } : null;
      }
      if (sql.includes("from projects")) {
        return projects.has(params[1]) ? { id: params[1] } : null;
      }
      if (sql.includes("from leads") && sql.includes("for share")) {
        return options.lead ?? null;
      }
      if (sql.includes("from contacts") && sql.includes("for share")) {
        return options.contacts?.[params[1]] ?? null;
      }
      if (sql.includes("from workspace_users") && sql.includes("for share")) {
        return workspaceUsers.has(params[1]) ? { id: params[1] } : null;
      }
      if (sql.startsWith("insert into seller_listings")) {
        return {
          ...listing,
          ownerUserId: params[6] ?? null,
          projectId: params[1],
        };
      }
      if (sql.startsWith("update seller_listings")) return listing;
      if (sql.startsWith("update property_units")) return { id: unitId };
      if (sql.startsWith("insert into property_text_blocks")) return { id: contactId };
      if (sql.startsWith("insert into property_activity_events")) return { id: leadId };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const output = ts.transpileModule(repositorySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: "src/lib/db/property-department-repositories.ts",
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    URL,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (specifier === "@/lib/broker-flow/access-policy") {
        return {
          canUseBrokerProjectEditScope: (session) =>
            session.productRole === "developer_sales" || session.productRole === "project_sales_member",
        };
      }
      if (specifier === "@/lib/contact-access") {
        return { canViewAllWorkspaceContacts: () => options.manager === true };
      }
      if (specifier === "@/lib/db/client") {
        return { queryOne: async () => { throw new Error("unguarded queryOne used"); } };
      }
      if (specifier === "@/lib/db/runtime-repositories") {
        return {
          canPersist: () => true,
          isUuid: (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value),
          writeAuditLog: async () => { state.audits += 1; },
        };
      }
      if (specifier === "@/lib/db/tenant-client") {
        return {
          withTenantTransaction: async (scope, callback) => {
            assert.equal(scope.actorId, actorId);
            assert.equal(scope.workspaceId, workspaceId);
            state.transactions += 1;
            return callback(transaction);
          },
        };
      }
      if (specifier === "@/lib/media-store") {
        return { findWorkspaceMediaAsset: async () => null };
      }
      if (specifier === "@/lib/db/content-library-repositories") {
        return { canAccessContentMediaAsset: async () => false };
      }
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import: ${specifier}`);
    },
  }, { filename: "src/lib/db/property-department-repositories.ts" });

  return { repository: cjsModule.exports, state };
}

async function saveOneTextBlock(repository, session, overrides = {}) {
  return repository.savePropertyTextBlocks({
    propertyId,
    session,
    textBlocks: [{ content: "Beschreibung", textKey: "description", title: "Beschreibung" }],
    ...overrides,
  });
}

test("unauthorized property fragments stop after the locked tenant record check", async () => {
  const { repository, state } = createHarness();
  const result = await saveOneTextBlock(repository, baseSession());

  assert.equal(result.persisted, false);
  assert.match(result.reason, /forbidden/);
  assert.equal(state.mutations.length, 0);
  assert.ok(state.queries.some(({ sql }) => sql.includes("from seller_listings") && sql.endsWith("for update")));
});

test("record owner, owned seller lead, and owned contact can mutate canonical fragments", async (t) => {
  const cases = [
    { name: "record owner", options: { listing: { ownerUserId: actorId } } },
    {
      name: "owned seller lead",
      options: {
        lead: { assignedToUserId: actorId, contactId: null },
        listing: { sellerLeadId: leadId },
      },
    },
    {
      name: "owned contact",
      options: {
        contacts: { [contactId]: { ownerUserId: actorId } },
        listing: { ownerContactId: contactId },
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { repository, state } = createHarness(item.options);
      const result = await saveOneTextBlock(repository, baseSession());
      assert.equal(result.persisted, true);
      assert.ok(state.mutations.some((sql) => sql.startsWith("delete from property_text_blocks")));
      assert.ok(state.mutations.some((sql) => sql.startsWith("insert into property_text_blocks")));
    });
  }
});

test("only eligible developer roles can use a positive locked project edit grant", async () => {
  const eligible = createHarness({ grantProjects: [projectA] });
  const allowed = await saveOneTextBlock(
    eligible.repository,
    baseSession({ productRole: "developer_sales" }),
  );
  assert.equal(allowed.persisted, true);
  assert.ok(eligible.state.queries.some(({ sql }) =>
    sql.includes("from project_pipeline_permissions")
      && sql.includes("can_edit_deals = true")
      && sql.endsWith("for update")));

  const ineligible = createHarness({ grantProjects: [projectA] });
  const denied = await saveOneTextBlock(ineligible.repository, baseSession({ productRole: "broker_agent" }));
  assert.equal(denied.persisted, false);
  assert.equal(ineligible.state.queries.some(({ sql }) => sql.includes("from project_pipeline_permissions")), false);
});

test("fragment project hints cannot override the locked listing project", async () => {
  const { repository, state } = createHarness({ listing: { ownerUserId: actorId } });
  const result = await saveOneTextBlock(repository, baseSession(), { projectId: projectB });

  assert.equal(result.persisted, false);
  assert.match(result.reason, /project scope/);
  assert.equal(state.mutations.length, 0);
});

test("record ownership cannot authorize a project move or owner reassignment", async () => {
  const moving = createHarness({ listing: { ownerUserId: actorId } });
  const move = await moving.repository.updateSellerListingRecord({
    property: { projectId: projectB },
    propertyId,
    session: baseSession(),
  });
  assert.equal(move.persisted, false);
  assert.match(move.reason, /target-project edit permission/i);
  assert.equal(moving.state.mutations.length, 0);

  const assigning = createHarness({ listing: { ownerUserId: actorId } });
  const reassignment = await assigning.repository.updateSellerListingRecord({
    property: { ownerUserId: otherUserId },
    propertyId,
    session: baseSession(),
  });
  assert.equal(reassignment.persisted, false);
  assert.match(reassignment.reason, /workspace-manager permission/i);
  assert.equal(assigning.state.mutations.length, 0);
});

test("create requires target-project edit but permits initial self ownership", async () => {
  const deniedHarness = createHarness();
  const denied = await deniedHarness.repository.createSellerListingRecord({
    property: {
      address: "Musterstraße 1",
      ownerUserId: actorId,
      projectId: projectA,
      title: "Testobjekt",
    },
    session: baseSession(),
  });
  assert.equal(denied.persisted, false);
  assert.match(denied.reason, /target-project edit permission/i);
  assert.equal(deniedHarness.state.mutations.length, 0);

  const allowedHarness = createHarness({ grantProjects: [projectA] });
  const allowed = await allowedHarness.repository.createSellerListingRecord({
    property: {
      address: "Musterstraße 1",
      ownerUserId: actorId,
      projectId: projectA,
      title: "Testobjekt",
    },
    session: baseSession({ productRole: "project_sales_member" }),
  });
  assert.equal(allowed.persisted, true);
  assert.equal(allowed.data.ownerUserId, actorId);
  assert.ok(allowedHarness.state.mutations.some((sql) => sql.startsWith("insert into seller_listings")));
});

test("all listing and fragment mutations share the central guard and canonical export replacement", () => {
  const guardCalls = repositorySource.match(/withLockedPropertyWriteGuard(?:<[^>]+>)?\(/g) ?? [];
  assert.ok(guardCalls.length >= 9, "expected guard definition plus eight guarded write entry points");
  assert.doesNotMatch(repositorySource, /findPropertyProjectId/);
  assert.doesNotMatch(repositorySource, /recordPropertyPreflightRun|insert into property_export_jobs/);
  assert.match(repositorySource, /projectId: scope\.projectId/g);
});
