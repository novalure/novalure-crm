import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const actorA = "33333333-3333-4333-8333-333333333333";
const projectA = "44444444-4444-4444-8444-444444444444";
const projectOther = "55555555-5555-4555-8555-555555555555";
const projectB = "19191919-1919-4919-8919-191919191919";
const propertyA = "66666666-6666-4666-8666-666666666666";
const propertyB = "77777777-7777-4777-8777-777777777777";
const unitA = "88888888-8888-4888-8888-888888888888";
const unitB = "99999999-9999-4999-8999-999999999999";
const contactA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const contactB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const leadA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const leadB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ownerA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ownerB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const funnelA = "12121212-1212-4212-8212-121212121212";
const funnelB = "13131313-1313-4313-8313-131313131313";
const formA = "14141414-1414-4414-8414-141414141414";
const formB = "15151515-1515-4515-8515-151515151515";
const inquiryId = "16161616-1616-4616-8616-161616161616";
const activityId = "17171717-1717-4717-8717-171717171717";
const unitOtherProject = "18181818-1818-4818-8818-181818181818";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function loadCommonJsTypeScript(path, dependencyMocks) {
  const output = ts.transpileModule(await source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
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
    Request,
    Response,
    Set,
    URL,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencyMocks, specifier)) return dependencyMocks[specifier];
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import in ${path}: ${specifier}`);
    },
  }, { filename: path });
  return cjsModule.exports;
}

function baseSession() {
  return {
    permissions: ["crm:read", "crm:write"],
    productRole: "operator",
    role: "admin",
    userId: actorA,
    workspaceId: workspaceA,
  };
}

function baseInquiry(overrides = {}) {
  return {
    contactEmail: "qa-a@example.test",
    sourceChannel: "Manual",
    workspaceId: workspaceA,
    ...overrides,
  };
}

function baseRoute(overrides = {}) {
  return {
    confidenceScore: 0.9,
    duplicateKey: "qa-a-example-test:unassigned",
    routingReason: "Canonical QA route",
    sourceChannel: "Manual",
    warnings: [],
    workspaceId: workspaceA,
    ...overrides,
  };
}

function createRepositoryHarness({ failActivity = false, failAudit = false } = {}) {
  const state = {
    activities: [],
    audits: [],
    calls: [],
    inquiries: [],
    transactions: 0,
  };
  const fixtures = {
    contacts: [
      { id: contactA, projectId: projectA, workspaceId: workspaceA },
      { id: contactB, projectId: projectA, workspaceId: workspaceB },
    ],
    forms: [
      { funnelId: funnelA, id: formA, projectId: projectA, workspaceId: workspaceA },
      { funnelId: funnelB, id: formB, projectId: projectA, workspaceId: workspaceB },
    ],
    funnels: [
      { id: funnelA, projectId: projectA, workspaceId: workspaceA },
      { id: funnelB, projectId: projectA, workspaceId: workspaceB },
    ],
    leads: [
      { contactId: contactA, id: leadA, projectId: projectA, workspaceId: workspaceA },
      { contactId: contactB, id: leadB, projectId: projectA, workspaceId: workspaceB },
    ],
    projects: [
      { id: projectA, workspaceId: workspaceA },
      { id: projectOther, workspaceId: workspaceA },
      { id: projectB, workspaceId: workspaceB },
    ],
    property_units: [
      { id: unitA, projectId: projectA, workspaceId: workspaceA },
      { id: unitOtherProject, projectId: projectOther, workspaceId: workspaceA },
      { id: unitB, projectId: projectA, workspaceId: workspaceB },
    ],
    seller_listings: [
      { id: propertyA, projectId: projectA, workspaceId: workspaceA },
      { id: propertyB, projectId: projectA, workspaceId: workspaceB },
    ],
    workspace_users: [
      { id: ownerA, workspaceId: workspaceA },
      { id: ownerB, workspaceId: workspaceB },
    ],
  };

  const transaction = {
    async execute(sql, params = []) {
      state.calls.push({ kind: "execute", params, sql });
    },
    async query(sql, params = []) {
      state.calls.push({ kind: "query", params, sql });
      return [];
    },
    async queryOne(sql, params = []) {
      state.calls.push({ kind: "queryOne", params, sql });
      for (const [table, rows] of Object.entries(fixtures)) {
        if (new RegExp(`from\\s+${table}\\b`, "i").test(sql)) {
          return rows.find((row) => row.workspaceId === params[0] && row.id === params[1]) ?? null;
        }
      }
      if (/from\s+property_inquiries\b/i.test(sql)) {
        return state.inquiries.find((row) => row.workspaceId === params[0] && row.duplicateKey === params[1]) ?? null;
      }
      if (/insert\s+into\s+property_inquiries\b/i.test(sql)) {
        const row = { duplicateKey: params[13], id: inquiryId, params, workspaceId: params[0] };
        state.inquiries.push(row);
        return { id: row.id };
      }
      if (/insert\s+into\s+property_activity_events\b/i.test(sql)) {
        if (failActivity) throw new Error("simulated activity failure");
        const row = { id: activityId, params };
        state.activities.push(row);
        return { id: row.id };
      }
      if (/insert\s+into\s+audit_logs\b/i.test(sql)) {
        if (failAudit) throw new Error("simulated audit failure");
        const row = { id: formB, params };
        state.audits.push(row);
        return { id: row.id };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const mocks = {
    "@/lib/db/client": {
      executeQuery() { throw new Error("global executeQuery must not be used"); },
      queryOne() { throw new Error("global queryOne must not be used"); },
    },
    "@/lib/db/runtime-repositories": {
      canPersist: () => true,
      isUuid: (value) => typeof value === "string" && uuidPattern.test(value),
      async writeAuditLog(input) { state.audits.push(input); },
    },
    "@/lib/db/tenant-client": {
      async withTenantTransaction(scope, callback) {
        state.transactions += 1;
        assert.equal(scope.actorId, actorA);
        assert.equal(scope.workspaceId, workspaceA);
        const snapshot = {
          activities: state.activities.length,
          audits: state.audits.length,
          inquiries: state.inquiries.length,
        };
        try {
          return await callback(transaction);
        } catch (error) {
          state.activities.length = snapshot.activities;
          state.audits.length = snapshot.audits;
          state.inquiries.length = snapshot.inquiries;
          throw error;
        }
      },
    },
    "@/lib/media-store": { findWorkspaceMediaAsset: async () => null },
  };

  return { mocks, state };
}

async function loadRepository(harness) {
  return loadCommonJsTypeScript("src/lib/db/property-department-repositories.ts", harness.mocks);
}

test("route_inquiry ignores client candidate arrays and loads canonical tenant candidates", async () => {
  const loaderCalls = [];
  let capturedCandidates;
  const canonicalAsset = {
    id: `listing:${propertyA}`,
    kind: "property",
    sellerListingId: propertyA,
    workspaceId: workspaceA,
  };
  const canonicalUnit = { id: unitA, workspaceId: workspaceA };
  const canonicalReservation = { id: activityId, workspaceId: workspaceA };
  const repositoryResult = baseRoute({ propertyId: canonicalAsset.id, projectId: projectA });
  const route = await loadCommonJsTypeScript("src/app/api/crm/properties/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    "@/lib/auth/session": {
      getRequestSession: async () => baseSession(),
      resolveWorkspaceScopedSession: async () => { throw new Error("GET auth must not run"); },
    },
    "@/lib/db/crm-loaders": {
      async loadPaginatedPropertyAssets(workspaceId, options) {
        loaderCalls.push({ kind: "assets", options, workspaceId });
        return {
          assets: [
            canonicalAsset,
            { id: `listing:${propertyB}`, kind: "property", sellerListingId: propertyB, workspaceId: workspaceB },
            { id: `project:${projectA}`, kind: "project", workspaceId: workspaceA },
          ],
          pagination: { hasMore: false, nextOffset: null },
        };
      },
      async loadPropertyReservations(workspaceId) {
        loaderCalls.push({ kind: "reservations", workspaceId });
        return [canonicalReservation, { id: formB, workspaceId: workspaceB }];
      },
      async loadPropertyUnits(workspaceId) {
        loaderCalls.push({ kind: "units", workspaceId });
        return [canonicalUnit, { id: unitB, workspaceId: workspaceB }];
      },
    },
    "@/lib/db/property-department-repositories": {
      async persistPropertyInquiryRoute({ route: routed }) {
        return { data: { id: inquiryId, route: routed, status: "routed" }, persisted: true };
      },
    },
    "@/lib/product-model": { hasProductCapability: () => false },
    "@/lib/property-department": {
      routePropertyInquiry(_inquiry, candidates) {
        capturedCandidates = candidates;
        return repositoryResult;
      },
      runPropertyChannelPreflight() { throw new Error("preflight must not run"); },
    },
    "@/lib/security/csrf": { enforceCsrfForSession: async () => ({ ok: true }) },
  });
  const response = await route.POST(new Request("https://crm.example.test/api/crm/properties", {
    body: JSON.stringify({
      assets: [{ id: `listing:${propertyB}`, workspaceId: workspaceB }],
      inquiry: { sourceChannel: "Manual" },
      operation: "route_inquiry",
      reservations: [{ id: formB, workspaceId: workspaceB }],
      units: [{ id: unitB, workspaceId: workspaceB }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(capturedCandidates)), {
    assets: [canonicalAsset],
    reservations: [canonicalReservation],
    units: [canonicalUnit],
  });
  assert.equal(loaderCalls.length, 3);
  assert.ok(loaderCalls.every((call) => call.workspaceId === workspaceA));
  assert.doesNotMatch(JSON.stringify(capturedCandidates), new RegExp(propertyB));
});

test("tenant A rejects every optional tenant B id before either domain insert", async () => {
  const foreignCases = [
    ["projectId", projectB],
    ["propertyId", `listing:${propertyB}`],
    ["unitId", unitB],
    ["contactId", contactB],
    ["leadId", leadB],
    ["ownerUserId", ownerB],
    ["funnelId", funnelB],
    ["formId", formB],
  ];

  for (const [field, value] of foreignCases) {
    const harness = createRepositoryHarness();
    const repository = await loadRepository(harness);
    const result = await repository.persistPropertyInquiryRoute({
      inquiry: baseInquiry({ [field]: value }),
      route: baseRoute({ [field]: value }),
      session: baseSession(),
    });

    assert.equal(result.persisted, false, `${field} must fail closed`);
    assert.match(result.reason, /Invalid or unavailable|Invalid or inconsistent/);
    assert.equal(harness.state.inquiries.length, 0, `${field} must not insert an inquiry`);
    assert.equal(harness.state.activities.length, 0, `${field} must not insert an activity`);
  }
});

test("same-tenant but cross-project property relationships fail closed", async () => {
  const harness = createRepositoryHarness();
  const repository = await loadRepository(harness);
  const result = await repository.persistPropertyInquiryRoute({
    inquiry: baseInquiry({ propertyId: `listing:${propertyA}`, unitId: unitOtherProject }),
    route: baseRoute({ propertyId: `listing:${propertyA}`, unitId: unitOtherProject }),
    session: baseSession(),
  });

  assert.equal(result.persisted, false);
  assert.match(result.reason, /inconsistent inquiry project relationship/);
  assert.equal(harness.state.inquiries.length, 0);
  assert.equal(harness.state.activities.length, 0);
});

test("inquiry and activity share one tenant transaction and activity failure rolls both back", async () => {
  const harness = createRepositoryHarness({ failActivity: true });
  const repository = await loadRepository(harness);
  const result = await repository.persistPropertyInquiryRoute({
    inquiry: baseInquiry({ projectId: projectA, propertyId: `listing:${propertyA}` }),
    route: baseRoute({ projectId: projectA, propertyId: `listing:${propertyA}` }),
    session: baseSession(),
  });

  assert.equal(result.persisted, false);
  assert.equal(harness.state.transactions, 1);
  assert.equal(harness.state.inquiries.length, 0);
  assert.equal(harness.state.activities.length, 0);
  assert.equal(harness.state.audits.length, 0);
});

test("audit evidence is in the same transaction and an audit failure rolls back domain writes", async () => {
  const harness = createRepositoryHarness({ failAudit: true });
  const repository = await loadRepository(harness);
  const result = await repository.persistPropertyInquiryRoute({
    inquiry: baseInquiry({ projectId: projectA, propertyId: `listing:${propertyA}` }),
    route: baseRoute({ projectId: projectA, propertyId: `listing:${propertyA}` }),
    session: baseSession(),
  });

  assert.equal(result.persisted, false);
  assert.equal(harness.state.transactions, 1);
  assert.equal(harness.state.inquiries.length, 0);
  assert.equal(harness.state.activities.length, 0);
  assert.equal(harness.state.audits.length, 0);
});

test("validated routing serializes duplicate checks and persists ID-free inquiry metadata", async () => {
  const harness = createRepositoryHarness();
  const repository = await loadRepository(harness);
  const ids = {
    contactId: contactA,
    formId: formA,
    funnelId: funnelA,
    leadId: leadA,
    ownerUserId: ownerA,
    projectId: projectA,
    propertyId: `listing:${propertyA}`,
    unitId: unitA,
  };
  const first = await repository.persistPropertyInquiryRoute({
    inquiry: baseInquiry(ids),
    route: baseRoute(ids),
    session: baseSession(),
  });
  const second = await repository.persistPropertyInquiryRoute({
    inquiry: baseInquiry(ids),
    route: baseRoute(ids),
    session: baseSession(),
  });

  assert.equal(first.persisted, true);
  assert.equal(first.data.status, "routed");
  assert.equal(first.data.route.propertyId, `listing:${propertyA}`);
  assert.equal(second.persisted, true);
  assert.equal(second.data.status, "duplicate");
  const lockIndex = harness.state.calls.findIndex((call) => /pg_advisory_xact_lock/i.test(call.sql));
  const duplicateReadIndex = harness.state.calls.findIndex((call) => /from\s+property_inquiries\b/i.test(call.sql));
  const inquiryInsert = harness.state.calls.find((call) => /insert\s+into\s+property_inquiries\b/i.test(call.sql));
  assert.ok(lockIndex >= 0 && lockIndex < duplicateReadIndex);
  assert.ok(inquiryInsert);
  const metadata = JSON.parse(inquiryInsert.params[15]);
  const serializedMetadata = JSON.stringify(metadata);
  for (const id of Object.values(ids)) {
    assert.doesNotMatch(serializedMetadata, new RegExp(id.replace(/^listing:/, "")));
  }
  assert.deepEqual(Object.keys(metadata.inquiry).sort(), ["contactEmail", "sourceChannel"]);
  assert.equal(harness.state.activities.length, 2);
  assert.equal(harness.state.audits.length, 2);
});

test("source contract keeps canonical loading, tenant predicates, advisory lock, and atomic writes", async () => {
  const [route, repository] = await Promise.all([
    source("src/app/api/crm/properties/route.ts"),
    source("src/lib/db/property-department-repositories.ts"),
  ]);
  const persistence = repository.slice(
    repository.indexOf("export async function persistPropertyInquiryRoute"),
    repository.indexOf("export async function recordPropertyPreflightRun"),
  );

  assert.doesNotMatch(route, /asArray<PropertyAssetSummary>\(input\.assets\)|input\.reservations|input\.units/);
  assert.match(route, /loadCanonicalPropertyInquiryCandidates\(session\.workspaceId\)/);
  assert.match(route, /loadPropertyUnits\(workspaceId\)/);
  assert.match(route, /loadPropertyReservations\(workspaceId\)/);
  for (const table of ["projects", "seller_listings", "property_units", "contacts", "leads", "workspace_users", "funnels", "forms"]) {
    assert.match(repository, new RegExp(`from\\s+${table}[\\s\\S]{0,160}workspace_id = \\$1::uuid`, "i"));
  }
  assert.match(persistence, /withTenantTransaction\([\s\S]*pg_advisory_xact_lock/);
  assert.match(persistence, /writePropertyActivityEvent\(\{[\s\S]*transaction,/);
  assert.match(persistence, /transaction\.queryOne<IdRow>\([\s\S]*insert into audit_logs/);
  assert.doesNotMatch(persistence, /JSON\.stringify\(\{ inquiry: input\.inquiry/);
});
