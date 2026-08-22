import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { splitPostgresStatements } from "./lib/postgres-statement-splitter.mjs";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
  publicSubmissionProofTtlSeconds,
  refreshPublicSubmissionProof,
  verifyPublicSubmissionProof,
} from "../src/lib/security/public-submission-abuse.ts";
import {
  defaultFunnelStepScore,
  resolveFunnelStepScore,
} from "../src/lib/funnel-step-score.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const secret = "funnel-runtime-proof-test-secret-".repeat(3);

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function scope({
  funnelId = "11111111-1111-4111-8111-111111111111",
  publicationRevision = 7,
  workspaceId = "22222222-2222-4222-8222-222222222222",
} = {}) {
  return buildPublicSubmissionScope({
    resourceId: `${funnelId}:publication:${publicationRevision}`,
    resourceType: "funnel",
    workspaceId,
  });
}

test("Funnel proof refresh works after fifteen minutes and preserves the exact idempotency identity", () => {
  const issuedAt = 2_000_000_000;
  const original = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: issuedAt,
    scope: scope(),
    secret,
  });
  const refreshAt = issuedAt + publicSubmissionProofTtlSeconds + 61;
  const refreshed = refreshPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: refreshAt,
    proof: original,
    scope: scope(),
    secret,
  });

  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(refreshed.proof.idempotencyKey, original.idempotencyKey);
  assert.equal(refreshed.proof.issuedAt, refreshAt);
  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      nowSeconds: refreshAt,
      proof: refreshed.proof,
      scope: scope(),
      secret,
    }).ok,
    true,
  );
});

test("workspace, Funnel and publication revision are independent proof boundaries", () => {
  const original = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 2_000_000_000,
    scope: scope(),
    secret,
  });
  const foreignScopes = [
    scope({ workspaceId: "33333333-3333-4333-8333-333333333333" }),
    scope({ funnelId: "44444444-4444-4444-8444-444444444444" }),
    scope({ publicationRevision: 8 }),
  ];

  for (const foreignScope of foreignScopes) {
    assert.equal(
      refreshPublicSubmissionProof({
        action: publicSubmissionActions.funnel,
        nowSeconds: 2_000_000_100,
        proof: original,
        scope: foreignScope,
        secret,
      }).ok,
      false,
    );
    assert.equal(
      verifyPublicSubmissionProof({
        action: publicSubmissionActions.funnel,
        nowSeconds: 2_000_000_100,
        proof: original,
        scope: foreignScope,
        secret,
      }).ok,
      false,
    );
  }
});

test("rotation between refresh and submit makes the refreshed old-publication proof unusable", () => {
  const original = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 2_000_000_000,
    scope: scope({ publicationRevision: 12 }),
    secret,
  });
  const refreshed = refreshPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 2_000_000_700,
    proof: original,
    scope: scope({ publicationRevision: 12 }),
    secret,
  });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;

  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      nowSeconds: 2_000_000_701,
      proof: refreshed.proof,
      scope: scope({ publicationRevision: 13 }),
      secret,
    }).ok,
    false,
  );
});

test("refresh and visit request contracts reject extra fields, invalid revisions and invalid visit identities", () => {
  const contract = readProjectFile("src/lib/funnel-runtime-contract.ts");

  assert.match(contract, /Object\.keys\(record\)\.some\(\(key\) => key !== "proof" && key !== "publicationRevision"\)/);
  assert.match(contract, /Number\.isSafeInteger\(value\)[\s\S]*Number\(value\) >= 0/);
  assert.match(contract, /key !== "proof" && key !== "publicationRevision" && key !== "visitId"/);
  assert.match(contract, /const visitIdPattern =[\s\S]*\^\[0-9a-f\]/);
  assert.match(contract, /parsePublicSubmissionProof\(record\.proof\)/);
  assert.match(contract, /funnel_publication_stale[\s\S]*reloadRequired === true/);
});

function createKpiHarness() {
  const events = new Set();
  const state = { leads: 0, visits: 0 };
  const current = {
    funnelId: "11111111-1111-4111-8111-111111111111",
    publicationRevision: 7,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  };
  const conversionRate = () => state.visits > 0 ? (state.leads / state.visits) * 100 : 0;
  return {
    read: () => ({ ...state, conversionRate: conversionRate() }),
    submit: () => {
      state.leads += 1;
      return { ...state, conversionRate: conversionRate() };
    },
    visit: ({ funnelId, publicationRevision, visitIdHash, workspaceId }) => {
      if (
        funnelId !== current.funnelId ||
        publicationRevision !== current.publicationRevision ||
        workspaceId !== current.workspaceId
      ) {
        return { accepted: false, counted: false, ...state, conversionRate: conversionRate() };
      }
      const key = `${workspaceId}:${funnelId}:${publicationRevision}:${visitIdHash}`;
      if (events.has(key)) return { accepted: true, counted: false, ...state, conversionRate: conversionRate() };
      events.add(key);
      state.visits += 1;
      return { accepted: true, counted: true, ...state, conversionRate: conversionRate() };
    },
  };
}

test("Page-Visit -> reload -> Submit produces a deduped database denominator and truthful KPI", () => {
  const harness = createKpiHarness();
  const visit = {
    funnelId: "11111111-1111-4111-8111-111111111111",
    publicationRevision: 7,
    visitIdHash: "a".repeat(64),
    workspaceId: "22222222-2222-4222-8222-222222222222",
  };

  assert.deepEqual(harness.visit(visit), {
    accepted: true,
    conversionRate: 0,
    counted: true,
    leads: 0,
    visits: 1,
  });
  assert.equal(harness.visit(visit).counted, false, "a reload reuses the same visit identity");
  assert.equal(harness.visit({ ...visit, publicationRevision: 8 }).accepted, false);
  assert.deepEqual(harness.read(), { conversionRate: 0, leads: 0, visits: 1 });
  assert.deepEqual(harness.submit(), { conversionRate: 100, leads: 1, visits: 1 });
  assert.equal(
    harness.visit({ ...visit, visitIdHash: "b".repeat(64) }).conversionRate,
    50,
  );
});

test("Visit route is bounded, current-publication-only and persists after cryptographic proof validation", () => {
  const route = readProjectFile("src/app/api/funnels/[funnelId]/visits/route.ts");
  const guard = route.indexOf('evaluateLaunchScope("publicFunnelVisit")');
  const body = route.indexOf("readBoundedPublicSubmissionJson(");
  const lookup = route.indexOf("getStoredFunnel(funnelId)");
  const live = route.indexOf("isStoredFunnelPubliclyLive(");
  const revision = route.indexOf("visitRequest.publicationRevision !== publicationRevision");
  const proof = route.indexOf("verifyPublicSubmissionProof({");
  const rate = route.indexOf("consumePublicSubmissionRateLimits({");
  const persist = route.indexOf("recordPublicFunnelVisit({");

  assert.ok(guard >= 0 && guard < body && body < lookup);
  assert.ok(lookup < live && live < revision && revision < proof && proof < rate && rate < persist);
  assert.match(route, /funnelRuntimeRequestBodyLimits/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.match(route, /"Referrer-Policy": "no-referrer"/);
  assert.doesNotMatch(route, /publishToken|publicToken/);
});

test("Visit repository atomically inserts the analytics source and advances KPIs only once", () => {
  const repository = readProjectFile("src/lib/db/funnel-visit-repository.ts");
  const migration = readProjectFile("migrations/075_public_funnel_visit_truth.sql");
  const qaResetContract = readProjectFile("src/lib/qa-reset-contract.ts");
  const schema = readProjectFile("src/lib/db/schema.ts");

  assert.match(repository, /funnel\.workspace_id = \$1::uuid/);
  assert.match(repository, /funnel\.id = \$2::uuid/);
  assert.match(repository, /publicationRevision[\s\S]*= \$3::numeric/);
  assert.match(repository, /for update of funnel/);
  assert.match(repository, /public_funnel_visit_events[\s\S]*public_funnel_visit_events_scope_key[\s\S]*relation_constraint\.contype = 'u'[\s\S]*public_funnel_visit_events_funnel_fk[\s\S]*relation_constraint\.contype = 'f'/);
  assert.match(repository, /insert into public_funnel_visit_events/);
  assert.match(repository, /expired_visit_identities[\s\S]*limit 64[\s\S]*for update skip locked/);
  assert.match(repository, /delete from public_funnel_visit_events expired/);
  assert.match(repository, /insert into analytics_events/);
  assert.match(repository, /'funnel_visit'/);
  assert.match(repository, /on conflict \(workspace_id, funnel_id, publication_revision, visit_id_hash\)[\s\S]*do nothing/);
  assert.match(repository, /visits = funnel\.visits \+ 1/);
  assert.match(repository, /exists \(select 1 from inserted_visit_event\)/);
  assert.match(repository, /funnel\.leads_count::numeric \/ \(funnel\.visits \+ 1\)::numeric/);
  assert.doesNotMatch(repository, /publishToken|publicToken|clientIp|signature/);
  assert.doesNotMatch(repository, /'visitIdHash'/);

  assert.match(migration, /create table if not exists public\.public_funnel_visit_events/);
  assert.match(migration, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(migration, /unique \(workspace_id, funnel_id, publication_revision, visit_id_hash\)/);
  assert.match(migration, /expires_at timestamptz not null default \(now\(\) \+ interval '90 days'\)/);
  assert.match(migration, /eligible for deletion after 90 days[\s\S]*independently scheduled and monitored deletion job/);
  assert.match(migration, /public_funnel_visit_events_expiry_idx/);
  assert.match(migration, /foreign key \(workspace_id, funnel_id\)[\s\S]*references public\.funnels\(workspace_id, id\)/);
  assert.match(migration, /grant select, insert, delete on table public\.public_funnel_visit_events[\s\S]*to novalure_tenant_app/);
  assert.match(migration, /grant select, insert, delete on table public\.public_funnel_visit_events to novalure_app/);
  assert.match(schema, /"public_funnel_visit_events"/);
  assert.match(qaResetContract, /qaResetCascadeOwnedTables[\s\S]*"public_funnel_visit_events"/);
});

test("Production Funnel KPIs do not render LAUNCH-OFF visits or conversion as zero truth", () => {
  const commandCenter = readProjectFile("src/components/funnel-command-center.tsx");
  const blueprintDesigner = readProjectFile("src/components/funnel-blueprint-designer.tsx");
  const builderAdapter = readProjectFile("src/lib/funnel-builder-adapter.ts");
  const launchScope = readProjectFile("src/lib/launch-scope.ts");

  assert.match(commandCenter, /publicVisitMetricsAvailable = dataMode === "demo" \|\| evaluateLaunchScope\("publicFunnelVisit"\)\.allowed/);
  assert.match(commandCenter, /data-funnel-metric-available=\{publicVisitMetricsAvailable \? "true" : "false"\}/);
  assert.match(commandCenter, /Public-Funnel-Visit-Tracking ist LAUNCH-OFF/);
  assert.match(commandCenter, /\[text\.visits, publicVisitMetricsAvailable \? formatNumber\(selected\.funnel\.visits/);
  assert.match(commandCenter, /\[text\.conversion, publicVisitMetricsAvailable \? `\$\{formatPercent\(selectedConversion/);
  assert.match(commandCenter, /publicVisitMetricsAvailable \? ` · \$\{step\.conversionRate\}%` : ""/);
  assert.doesNotMatch(commandCenter, /score:\s*Math\.max\([^\n]*step\.conversionRate/);
  assert.match(commandCenter, /publicVisitMetricsAvailable \? <div className="grid gap-3 lg:grid-cols/);
  assert.equal((commandCenter.match(/visitMetricsAvailable=\{publicVisitMetricsAvailable\}/g) ?? []).length, 2);
  assert.match(blueprintDesigner, /visitMetricsAvailable = false/);
  assert.match(blueprintDesigner, /visitMetricsAvailable \? calculateAbTestResults\(blueprint\.variants\) : \[\]/);
  assert.match(blueprintDesigner, /data-funnel-ab-metrics-available=\{visitMetricsAvailable \? "true" : "false"\}/);
  assert.match(blueprintDesigner, /visitMetricsAvailable \? abRows\.map/);
  assert.match(blueprintDesigner, /A\/B-Besuche, Conversion, Lift und Konfidenz sind nicht verfügbar/);
  assert.match(builderAdapter, /score: resolveFunnelStepScore\(step\.score\)/);
  assert.doesNotMatch(builderAdapter, /score:[^\n]*conversionRate/);
  assert.match(launchScope, /One shared consent cohort for the visit denominator and lead numerator/);
  assert.match(launchScope, /independently scheduled and monitored deletion job/);
});

test("missing Funnel step score has a stable domain default independent of visit conversion", () => {
  assert.equal(defaultFunnelStepScore, 10);
  assert.equal(resolveFunnelStepScore(undefined), 10);
  assert.equal(resolveFunnelStepScore(null), 10);
  assert.equal(resolveFunnelStepScore(0), 0);
  assert.equal(resolveFunnelStepScore(25), 25);
});

test("Visit truth migration is fully parseable by the guarded migration statement splitter", () => {
  const migration = readProjectFile("migrations/075_public_funnel_visit_truth.sql");
  const statements = splitPostgresStatements(migration);

  assert.equal(statements.length, 9);
  assert.match(statements[2], /do \$migration\$[\s\S]*migration 074_validate_launch_tenant_relation_guards/);
  assert.match(statements[3], /create table if not exists public\.public_funnel_visit_events/);
  assert.match(statements[6], /grant select, insert, delete[\s\S]*novalure_tenant_app/);
});

test("Client refreshes before expiry, retries only explicit expiry once, and never forwards the URL token", () => {
  const renderer = readProjectFile("src/components/funnel-renderer.tsx");
  const requestBuilder = readProjectFile("src/lib/funnel-submission-request.ts");
  const page = readProjectFile("src/app/preview/[funnelId]/page.tsx");
  const submit = renderer.slice(renderer.indexOf("async function submit"), renderer.indexOf("function renderElement"));
  const invalidBranch = submit.slice(submit.indexOf('responsePayload?.error === "submission_proof_invalid"'));

  assert.match(renderer, /publicSubmissionProofRefreshLeadSeconds/);
  assert.match(renderer, /proof\.idempotencyKey !== currentProof\.idempotencyKey/);
  assert.match(renderer, /getOrCreatePublicFunnelVisitId/);
  assert.match(renderer, /!visitTrackingEnabled[\s\S]*!runtimeConsent\.analytics/);
  assert.match(renderer, /data-funnel-runtime-error=\{reloadRequired \? "publication-stale"/);
  assert.match(submit, /const submissionIntentId[\s\S]*const sendAttempt/);
  assert.match(submit, /submission_proof_expired[\s\S]*return sendAttempt\(refreshedProof, false\)/);
  assert.match(submit, /isFunnelPublicationStaleResponse\(responsePayload\)[\s\S]*markPublicationStale\(\)[\s\S]*funnel_publication_stale/);
  assert.doesNotMatch(invalidBranch, /return sendAttempt\(/);
  assert.match(requestBuilder, /credentials: "omit"/);
  assert.match(requestBuilder, /referrerPolicy: "no-referrer"/);
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(page, /visitTrackingEnabled=\{mode === "live" && evaluateLaunchScope\("publicFunnelVisit"\)\.allowed\}/);
  assert.ok(page.indexOf("canUsePublicLiveFunnel") < page.indexOf("createPublicSubmissionProof({"));
});

test("Funnel refresh route preserves scope identity and signals a stale publication before signing", () => {
  const route = readProjectFile("src/app/api/funnels/[funnelId]/submission-proof/route.ts");
  const guard = route.indexOf('evaluateLaunchScope("publicFunnelProofRefresh")');
  const body = route.indexOf("readBoundedPublicSubmissionJson(");
  const rate = route.indexOf("consumePublicSubmissionRateLimits({");
  const lookup = route.indexOf("getStoredFunnel(funnelId)");
  const revision = route.indexOf("refreshRequest.publicationRevision !== publicationRevision");
  const refresh = route.indexOf("refreshPublicSubmissionProof({");

  assert.ok(guard >= 0 && guard < body && body < rate && rate < lookup);
  assert.ok(lookup < revision && revision < refresh);
  assert.match(route, /getStoredFunnelSubmissionScopeResourceId/);
  assert.match(route, /workspaceId: stored\.workspaceId/);
  assert.match(route, /funnel_publication_stale/);
  assert.match(route, /reloadRequired: true/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.match(route, /"Referrer-Policy": "no-referrer"/);
  assert.doesNotMatch(route, /publishToken|publicToken/);
});
