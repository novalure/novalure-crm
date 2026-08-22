import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  funnelMetricSemantics,
  getFunnelLifetimeMetrics,
  getFunnelViewCounts,
  isExplicitFixtureDemoMode,
  isPersistedFunnelId,
  mergeFunnelRecordsById,
} from "../src/lib/funnel-command-metrics.ts";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("funnel views count funnel entities, never matching steps", () => {
  const entities = [
    {
      funnel: { id: "one", leads: 10, status: "aktiv", visits: 100 },
      steps: [
        { botRuleId: "bot-1", status: "blockiert", type: "Bot" },
        { botRuleId: "bot-2", status: "blockiert", type: "Bot" },
      ],
    },
    {
      funnel: { id: "two", leads: 5, status: "optimieren", visits: 50 },
      steps: [{ botRuleId: "bot-3", status: "aktiv", type: "Bot" }],
    },
    {
      funnel: { id: "three", leads: 0, status: "entwurf", visits: 0 },
      steps: [],
    },
  ];

  assert.deepEqual(getFunnelViewCounts(entities), {
    active: 1,
    all: 3,
    blocked: 1,
    bots: 2,
    optimize: 1,
  });
});

test("funnel conversion uses one transparent lifetime denominator", () => {
  const metrics = getFunnelLifetimeMetrics([
    { funnel: { id: "one", leads: 10, status: "aktiv", visits: 100 }, steps: [] },
    { funnel: { id: "two", leads: 5, status: "optimieren", visits: 50 }, steps: [] },
  ]);

  assert.deepEqual(metrics, { conversionRate: 10, denominator: 150, leads: 15, visits: 150 });
  assert.match(funnelMetricSemantics.attribution, /entry_channel/);
  assert.equal(funnelMetricSemantics.source, "funnels.visits and funnels.leads_count");
  assert.match(funnelMetricSemantics.period, /lifetime/i);
  assert.match(funnelMetricSemantics.denominator, /leads_count.*visits/i);
  assert.ok(funnelMetricSemantics.excludes.includes("project-wide CRM leads"));
  assert.ok(funnelMetricSemantics.excludes.includes("test submission records"));
});

test("fixture demo mode is explicit and impossible in production", () => {
  assert.equal(isPersistedFunnelId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isPersistedFunnelId("funnel_wohnpark_buyer"), false);
  assert.equal(isExplicitFixtureDemoMode({ nodeEnv: "development", requestedMode: "demo" }), true);
  assert.equal(isExplicitFixtureDemoMode({ nodeEnv: "development", requestedMode: null }), false);
  assert.equal(isExplicitFixtureDemoMode({ nodeEnv: "production", requestedMode: "demo" }), false);
});

test("persisted and just-saved funnel records are de-duplicated by ID", () => {
  const persisted = [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Server" }];
  const local = [
    { id: "550e8400-e29b-41d4-a716-446655440000", name: "Latest local state" },
    { id: "funnel_new_1", name: "Unsaved" },
  ];

  assert.deepEqual(mergeFunnelRecordsById(persisted, local), [local[0], local[1]]);
});

test("blueprint API is authenticated, database-only, and fail-closed", async () => {
  const route = await source("src/app/api/funnels/[funnelId]/blueprint/route.ts");
  const responseDto = await source("src/lib/funnel-store-response.ts");

  assert.doesNotMatch(route, /@\/lib\/crm-source/);
  assert.doesNotMatch(route, /findFunnelBlueprint/);
  assert.match(route, /requirePermissionAndProductCapability\(_request, "funnels:write", "funnels:publish"\)/);
  assert.match(route, /getStoredFunnel\(funnelId, auth\.session\.workspaceId\)/);
  assert.match(route, /toFunnelBlueprintResponse\(stored\)/);
  assert.match(responseDto, /source: stored\.source/);
  assert.doesNotMatch(responseDto, /^\s*(?:tracking|publishToken|publicToken):/mu);
  assert.match(route, /if \(!stored\).*funnelNotFound/s);
  assert.match(route, /status: 503/);
});

test("submission API never accepts fixture truth or reports failed persistence as success", async () => {
  const route = await source("src/app/api/funnels/[funnelId]/submissions/route.ts");

  assert.doesNotMatch(route, /@\/lib\/crm-source/);
  assert.doesNotMatch(route, /findFunnelBlueprint/);
  assert.match(route, /record\.mode !== "test" && record\.mode !== "live"/);
  assert.match(route, /if \(!stored\?\.funnelId \|\| !stored\.workspaceId\)/);
  assert.match(route, /readBoundedPublicSubmissionJson\(request, funnelSubmissionBodyLimits\)/);
  assert.match(route, /canonicalizeFunnelSubmissionPayload\(blueprint, payload\)/);
  assert.match(route, /isStoredFunnelPubliclyLive\(\{ blueprint, stored \}\)/);
  assert.match(route, /verifyPublicSubmissionProof\(\{/);
  assert.match(route, /claimPublicSubmissionIdempotency\(\{[\s\S]*?allowLeaseReclaim: true,[\s\S]*?\}\)/);
  assert.doesNotMatch(route, /getRequestToken|x-novalure-funnel-token|x-funnel-token/);
  assert.match(route, /if \(!persistence\.persisted\)/);
  assert.match(route, /residueFree: false/);
  assert.match(route, /records: \["funnel_submissions", "audit_logs", "crm_analytics_events"\]/);
  assert.doesNotMatch(route, /submissionId: persistence\.persisted \?/);
});

test("submission persistence only resolves an exact existing database funnel", async () => {
  const repository = await source("src/lib/db/runtime-repositories.ts");

  assert.doesNotMatch(repository, /getOrCreateSubmissionFunnel/);
  assert.doesNotMatch(repository, /createdFromSubmission/);
  assert.match(repository, /findSubmissionFunnel\(input\.session, input\.databaseFunnelId\)/);
  assert.match(repository, /and id = \$2::uuid/);
  assert.match(repository, /and project_id is not null/);
  assert.doesNotMatch(repository, /or name = \$4/);
});

test("funnel store has no local file fallback and cannot insert unknown blueprints", async () => {
  const store = await source("src/lib/funnel-store.ts");

  assert.doesNotMatch(store, /node:fs\/promises|funnels\.json|readStore|writeStore|source: "local"/);
  assert.match(store, /throw new Error\("Funnel database is not configured"\)/);
  assert.match(store, /if \(!isUuid\(funnelId\)\) return null/);
  assert.match(store, /if \(workspaceId != null && !isUuid\(workspaceId\)\) return null/);
  assert.match(store, /where f\.id = \$1::uuid/);
  assert.doesNotMatch(store, /tracking->>'legacyId'|legacyProjectNames|legacyProjectId/);
  assert.match(store, /if \(!existingRow\) throw new Error\("Funnel not found in database"\)/);
  assert.doesNotMatch(store, /insert into funnels/);
  assert.doesNotMatch(store, /order by created_at asc\s+limit 1/);
});

test("cockpit excludes fixtures by default and discloses KPI and test residue semantics", async () => {
  const component = await source("src/components/funnel-command-center.tsx");
  const adapter = await source("src/lib/funnel-builder-adapter.ts");

  assert.match(component, /funnels\.filter\(\(funnel\) => isPersistedFunnelId\(funnel\.id\)\)/);
  assert.match(component, /getFunnelViewCounts\(decoratedFunnels\)/);
  assert.match(component, /getFunnelLifetimeMetrics\(decoratedFunnels\)/);
  assert.doesNotMatch(component, /leads\.length/);
  assert.doesNotMatch(component, /relatedLeads/);
  assert.match(component, /Test submissions are not residue-free/);
  assert.match(component, /funnelDataMode/);
  assert.match(adapter, /options\.mode !== "demo" \|\| process\.env\.NODE_ENV === "production"/);
});
