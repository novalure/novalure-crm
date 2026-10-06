import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const loaders = read("src/lib/db/crm-loaders.ts");
const types = read("src/lib/crm-types.ts");
const unitBoard = read("src/components/unit-board.tsx");
const customerAccess = read("src/lib/db/customer-access-repositories.ts");
const recommendationRuntime = read("src/lib/db/recommendation-runtime-repositories.ts");
const dealPipeline = read("src/components/deal-pipeline-workspace.tsx");
const financialSnapshots = read("src/lib/db/financial-snapshot-repositories.ts");
const financialSnapshotRoute = read("src/app/api/crm/financial-snapshots/route.ts");
const financialPolicyRoute = read("src/app/api/crm/financial-policies/route.ts");
const evelynContractRoute = read("src/app/api/crm/evelyn-contracts/route.ts");
const boundedCrmBody = read("src/lib/crm-request-body.ts");
const offerWorkflow = read("src/components/offer-workflow.tsx");
const analysisBot = read("src/components/crm-analysis-bot.tsx");

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("property sales reporting projects the latest immutable snapshot", () => {
  assert.match(loaders, /snapshot\.resource_type = 'PROPERTY_SALE'/);
  assert.match(loaders, /snapshot\.project_id = pu\.project_id/);
  assert.match(loaders, /snapshot\.resource_id = sale\.id/);
  assert.match(loaders, /order by snapshot\.business_version desc, snapshot\.id desc/);
  assert.match(loaders, /canonical_snapshot#>>'\{totals,net,minorUnits\}'/);
  assert.match(loaders, /review_state = 'VERIFIED'/);
  assert.match(loaders, /canonical_snapshot->>'reviewState' = 'COMPLETE'/);
  assert.match(loaders, /canonical_snapshot->>'currency' = 'EUR'/);
  assert.match(loaders, /canonical_snapshot->>'minorUnitExponent' = '2'/);
  assert.match(loaders, /soldValueReviewCount/);
  assert.match(loaders, /soldValueCurrencyMismatchCount/);
  assert.doesNotMatch(loaders, /sum\(pu\.price_cents\) filter \(where pu\.status = 'sold'\)/);
  assert.match(loaders, /\)::text as "totalSalesValueCents"/);
  assert.match(loaders, /\)::text as "soldValueCents"/);
  assert.doesNotMatch(loaders, /soldValueCents: Number/);

  assert.match(types, /historicalSaleNetMinorUnits\?: string/);
  assert.match(types, /historicalSaleReviewState\?: FinancialReviewState/);
  assert.match(types, /export type FinancialReviewState = "NEEDS_REVIEW" \| "VERIFIED"/);
});

test("unit board sums exact verified values only when currency and exponent agree", () => {
  assert.match(unitBoard, /summarizeHistoricalSaleValue\(visibleUnits\)/);
  assert.match(unitBoard, /unit\.historicalSaleReviewState !== "VERIFIED"/);
  assert.match(unitBoard, /new Set\(verifiedValues\.map\(\(value\) => `\$\{value\.currency\}:\$\{value\.exponent\}`\)\)/);
  assert.match(unitBoard, /dimensions\.size !== 1/);
  assert.match(unitBoard, /sum \+ BigInt\(value\.minorUnits\)/);
  assert.match(unitBoard, /"Mehrere Währungen"/);
  assert.match(unitBoard, /"Finanzprüfung offen"/);
  assert.match(unitBoard, /"Historischer Geld-\/Steuerstand: Prüfung offen"/);
  assert.doesNotMatch(
    unitBoard,
    /filter\(\(unit\) => unit\.status === "sold"\)[\s\S]{0,160}sum \+ unit\.priceCents/,
  );
});

test("customer project revenue avoids lead multiplication and mutable deal values", () => {
  const projectLoader = section(customerAccess, "async function loadCustomerProjects", "async function loadProjectGrants");
  assert.match(projectLoader, /left join lateral \([\s\S]*from leads lead_record/);
  assert.match(projectLoader, /snapshot\.resource_type = 'DEAL'/);
  assert.match(projectLoader, /snapshot\.project_id = deal_record\.project_id/);
  assert.match(projectLoader, /snapshot\.resource_id = deal_record\.id/);
  assert.match(projectLoader, /order by snapshot\.business_version desc, snapshot\.id desc/);
  assert.match(projectLoader, /review_state = 'VERIFIED'/);
  assert.match(projectLoader, /canonical_snapshot->>'reviewState' = 'COMPLETE'/);
  assert.match(projectLoader, /verified_dimensions as \([\s\S]*group by[\s\S]*canonical_snapshot->>'currency'/);
  assert.match(projectLoader, /case when count\(\*\) = 1 then min\(minor_units\) else null end/);
  assert.match(projectLoader, /"revenueReviewCount"/);
  assert.doesNotMatch(projectLoader, /sum\([^)]*value_cents/i);
  assert.doesNotMatch(projectLoader, /left join deals d\b/i);

  assert.match(customerAccess, /Finanzprüfung\(en\) offen/);
  assert.match(types, /revenueReviewCount\?: number/);
});

test("conversion revenue is time-bound verified EUR exponent-2 snapshot money", () => {
  const conversionWriter = section(
    recommendationRuntime,
    "async function createConversionAnalyticsSnapshotInTransaction",
    "async function runCustomerOnboardingRiskAutomationInTransaction",
  );
  assert.match(conversionWriter, /with terminal_deal_financials as \(/);
  assert.match(conversionWriter, /from deals deal_record/);
  assert.match(conversionWriter, /left join lateral \([\s\S]*from crm_financial_snapshots snapshot/);
  assert.match(conversionWriter, /snapshot\.resource_type = 'DEAL'/);
  assert.match(conversionWriter, /deal_record\.stage = 'Gewonnen'/);
  assert.match(conversionWriter, /coalesce\([\s\S]*canonical_snapshot->>'effectiveAt'[\s\S]*deal_record\.closed_at[\s\S]*deal_record\.created_at[\s\S]*between \$3::timestamptz and \$4::timestamptz/);
  assert.match(conversionWriter, /snapshot_id is null[\s\S]*review_state <> 'VERIFIED'[\s\S]*canonical_snapshot->>'reviewState' <> 'COMPLETE'/);
  assert.match(conversionWriter, /review_state = 'VERIFIED'/);
  assert.match(conversionWriter, /canonical_snapshot->>'reviewState' = 'COMPLETE'/);
  assert.match(conversionWriter, /canonical_snapshot->>'currency' = 'EUR'/);
  assert.match(conversionWriter, /canonical_snapshot->>'minorUnitExponent' = '2'/);
  assert.match(conversionWriter, /'financialReviewCount', revenue_summary\.review_count/);
  assert.match(conversionWriter, /'financialPolicyRequiredCount', revenue_summary\.policy_required_count/);
  assert.doesNotMatch(conversionWriter, /sum\(value_cents\)/);
  assert.doesNotMatch(conversionWriter, /deal_record\.value_cents/);
  assert.doesNotMatch(conversionWriter, /deal_record\.updated_at/);
  assert.doesNotMatch(conversionWriter, /closed_revenue_cents[\s\S]{0,20}::bigint/);
  assert.match(conversionWriter, /stage in \('Verloren', 'Disqualifiziert', 'Pausiert \/ Verloren'\)/);
  assert.match(recommendationRuntime, /closedRevenueCents: string/);
  assert.match(recommendationRuntime, /closed_revenue_cents::text as "closedRevenueCents"/);
  assert.match(recommendationRuntime, /metadata->>'financialPolicyRequiredCount'/);
  assert.match(recommendationRuntime, /financialSnapshotSchemaVersion === "financial-snapshot-v1"/);
  assert.match(recommendationRuntime, /closedRevenueCurrency === "EUR"/);
  assert.match(recommendationRuntime, /closedRevenueMinorUnitExponent === "2"/);
  assert.doesNotMatch(recommendationRuntime, /closedRevenueCents: Number/);
  assert.match(analysisBot, /closedRevenueAuthoritative/);
  assert.match(analysisBot, /unverifiedRevenueWarning/);
  assert.match(analysisBot, /financialCoverageWarning/);
  assert.match(analysisBot, /financialReviewCount > 0/);
  assert.match(analysisBot, /financialPolicyRequiredCount > 0/);
});

test("pipeline terminal values and deal UI use immutable exact snapshots", () => {
  const report = section(
    recommendationRuntime,
    "async function createPipelineManagementReport",
    "async function createFunnelConversionOperationalReports",
  );
  assert.match(report, /snapshot\.resource_type = 'DEAL'/);
  assert.match(report, /latest_snapshot\.canonical_snapshot#>>'\{totals,net,minorUnits\}'/);
  assert.match(report, /deal_record\.stage not in \('Gewonnen','Verloren','Disqualifiziert','Pausiert \/ Verloren'\)[\s\S]*deal_record\.value_cents::numeric/);
  assert.equal((report.match(/stage not in \('Gewonnen','Verloren','Disqualifiziert','Pausiert \/ Verloren'\)/g) ?? []).length, 6);
  assert.match(report, /where stage in \('Verloren','Disqualifiziert','Pausiert \/ Verloren'\)[\s\S]*lost_reason_category is not null/);
  assert.match(report, /coalesce\(sum\(report_value_cents\), 0\)::text as value_cents/);
  assert.match(report, /financial_review_count/);
  assert.match(report, /terminalValuesSource', 'financial-snapshot-v1'/);
  assert.doesNotMatch(report, /select owner_user_id, count\(\*\) as deals, coalesce\(sum\(value_cents\)/);
  assert.doesNotMatch(report, /select stage, count\(\*\) as deals, coalesce\(sum\(value_cents\)/);

  assert.match(loaders, /snapshot\.resource_type = 'DEAL'/);
  assert.match(loaders, /historicalFinancialNetMinorUnits/);
  assert.match(types, /historicalFinancialReviewState\?: FinancialReviewState/);
  assert.match(dealPipeline, /summarizeTerminalDealValues/);
  assert.match(dealPipeline, /historicalFinancialReviewState !== "VERIFIED"/);
  assert.match(dealPipeline, /valueMinorUnits \+= value/);
  assert.match(dealPipeline, /financialReviewOpen/);
});

test("G27 JSON routes enforce the shared streaming 16 KiB boundary", () => {
  for (const route of [evelynContractRoute, financialPolicyRoute, financialSnapshotRoute]) {
    assert.match(route, /readBoundedCrmJson\(request\)/);
    assert.doesNotMatch(route, /request\.(?:text|json)\(/);
  }
  assert.match(boundedCrmBody, /request\.headers\.get\("content-length"\)/);
  assert.match(boundedCrmBody, /request\.body\?\.getReader\(\)/);
  assert.match(boundedCrmBody, /totalBytes > maximumBytes/);
  assert.match(boundedCrmBody, /reader\.cancel\("BODY_TOO_LARGE"\)/);
});

test("offer document money comes from the preferred immutable snapshot and print fails closed", () => {
  const offerProjection = section(
    financialSnapshots,
    "export async function getOfferFinancialSnapshot",
    "export async function listFinancialReviewQueue",
  );
  assert.match(offerProjection, /snapshot\.resource_type='CONTRACT'/);
  assert.match(offerProjection, /canonical_snapshot#>>'\{provenance,sourceRecordId\}'=\$2::text/);
  assert.match(offerProjection, /snapshot\.resource_type='OFFER' and snapshot\.resource_id=\$2::uuid/);
  assert.match(offerProjection, /case when snapshot\.resource_type='CONTRACT' then 0 else 1 end/);
  assert.match(financialSnapshotRoute, /query\.get\("offerId"\)/);
  assert.match(offerWorkflow, /offerId=\$\{encodeURIComponent\(offerId\)\}/);
  assert.match(offerWorkflow, /authoritativeFinancialSnapshot\.snapshot\.totals\.net/);
  assert.match(offerWorkflow, /authoritativeFinancialSnapshot\.snapshot\.totals\.tax/);
  assert.match(offerWorkflow, /authoritativeFinancialSnapshot\.snapshot\.totals\.gross/);
  assert.match(offerWorkflow, /Druck gesperrt: Es liegt kein vollständig verifizierter Finanzsnapshot vor/);
  assert.match(offerWorkflow, /disabled=\{busy \|\| !authoritativeFinancialSnapshot/);
  assert.doesNotMatch(offerWorkflow, /money\(offer\.totalNetCents\)/);
  assert.doesNotMatch(offerWorkflow, /money\(item\.quantity \* item\.unitNetCents\)/);
});
