import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loaderSource = (await readFile(
  new URL("../src/lib/db/crm-loaders.ts", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const propertyRouteSource = (await readFile(
  new URL("../src/app/api/crm/properties/route.ts", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const coreRouteSource = (await readFile(
  new URL("../src/app/api/crm/core/route.ts", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const homePageSource = (await readFile(
  new URL("../src/app/page.tsx", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");

function functionSource(name) {
  const start = loaderSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextFunction = loaderSource.indexOf("\nfunction ", start + 1);
  const nextExportedFunction = loaderSource.indexOf("\nexport async function ", start + 1);
  const candidates = [nextFunction, nextExportedFunction].filter((value) => value >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : loaderSource.length;
  return loaderSource.slice(start, end);
}

function exportedFunctionSource(name) {
  const start = loaderSource.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = loaderSource.indexOf("\nexport async function ", start + 1);
  return loaderSource.slice(start, end < 0 ? undefined : end);
}

test("core CRM payload keeps manager visibility but builds a fail-closed actor scope", () => {
  const scope = functionSource("getCrmActorVisibilityScope");
  const fallback = functionSource("getSessionScopedFallbackData");
  const core = exportedFunctionSource("getCoreCrmData");

  assert.match(scope, /canViewAllWorkspaceContacts\(session\)/);
  assert.match(scope, /canUseBrokerProjectEditScope\(session\)/);
  assert.match(fallback, /calendarEvents\.filter\(\(event\) => event\.ownerUserId === session\.userId\)/);
  assert.match(fallback, /contacts\.filter\(\(contact\) => contact\.ownerUserId === session\.userId\)/);
  assert.match(fallback, /deals\.filter\(\(deal\) => deal\.ownerUserId === session\.userId\)/);
  assert.match(fallback, /leads\.filter\(\(lead\) => lead\.assignedToUserId === session\.userId\)/);
  assert.match(fallback, /tasks\.filter\(\(task\) => task\.ownerUserId === session\.userId\)/);
  assert.match(core, /const moduleFallbackData = getSessionScopedFallbackData\(fallbackData, options\.session\)/);
  assert.match(core, /Actor property scope failed closed/);
});

test("lead, deal, task and calendar loaders enforce owner or explicit project-edit visibility", () => {
  const cases = [
    ["loadLeads", /assigned_to_user_id = \$2::uuid/],
    ["loadDeals", /owner_user_id = \$2::uuid/],
    ["loadTasks", /t\.owner_user_id = \$2::uuid/],
    ["loadCalendarEvents", /owner_user_id = \$2::uuid/],
  ];

  for (const [name, ownerPattern] of cases) {
    const source = exportedFunctionSource(name);
    assert.match(source, ownerPattern);
    assert.match(source, /\$3::boolean[\s\S]*project_pipeline_permissions/);
    assert.match(source, /permission\.can_edit_deals = true/);
    assert.match(source, /visibilityScope\.allowProjectEditVisibility/);
  }
  assert.match(exportedFunctionSource("loadTasks"), /p\.workspace_id = t\.workspace_id/);
});

test("project shells and their aggregates use the actor's effective entitlements", () => {
  const source = exportedFunctionSource("loadProjects");

  assert.match(source, /access\.status = 'active'[\s\S]*access\.can_view_project = true/);
  assert.match(source, /permission\.can_edit_deals = true/);
  assert.match(source, /contact\.owner_user_id = \$2::uuid/);
  assert.match(source, /lead\.assigned_to_user_id = \$2::uuid/);
  assert.match(source, /deal\.owner_user_id = \$2::uuid/);
  assert.match(source, /task\.owner_user_id = \$2::uuid/);
  assert.match(source, /event\.owner_user_id = \$2::uuid/);
  assert.match(source, /from leads[\s\S]*\$\{actorEntityFilter\}[\s\S]*group by/);
  assert.match(source, /from deals[\s\S]*\$\{actorDealFilter\}[\s\S]*group by/);
  assert.match(source, /where p\.workspace_id = \$1[\s\S]*\$\{actorProjectFilter\}/);
});

test("permission roster and property payload distinguish edit rights from customer view rights", () => {
  const permissions = exportedFunctionSource("loadProjectPipelinePermissions");
  const projectIds = functionSource("loadActorPropertyProjectIds");
  const propertyScope = functionSource("applyActorPropertyScope");

  assert.match(permissions, /p\.user_id = \$2::uuid/);
  assert.match(permissions, /access\.status = 'active'[\s\S]*access\.can_view_project = true/);
  assert.match(projectIds, /permission\.can_edit_deals = true[\s\S]*\$3::boolean/);
  assert.match(projectIds, /editableProjectIds:[\s\S]*viewableProjectIds:/);
  assert.match(propertyScope, /projectScope\.viewableProjectIds\.has\(listing\.projectId\)/);
  assert.match(propertyScope, /projectScope\.editableProjectIds\.has\(mandate\.projectId\)/);
  assert.match(propertyScope, /projectScope\.editableProjectIds\.has\(profile\.projectId\)/);
  assert.match(propertyScope, /profile\.ownerUserId === session\.userId/);
  assert.doesNotMatch(propertyScope, /for \(const listing of visibleListings\) visibleProjectIds\.add/);
  assert.match(propertyScope, /directlyVisibleUnitIds/);
  assert.match(propertyScope, /buyerContactId: undefined[\s\S]*dealId: undefined[\s\S]*reservationId: undefined/);
  assert.match(propertyScope, /\["public", "channel"\]\.includes\(item\.visibility\)/);
  assert.match(propertyScope, /\["approved", "sent"\]\.includes\(item\.status\)/);
  assert.match(propertyScope, /projectScope\.editableProjectIds\.has\(reservation\.projectId\)[\s\S]*directlyVisibleUnitIds\.has/);
});

test("core buyer search profile DTO preserves the already-authorized record owner", async () => {
  const profiles = exportedFunctionSource("loadBuyerSearchProfiles");
  const crmTypes = await readFile(new URL("../src/lib/crm-types.ts", import.meta.url), "utf8");
  const buyerProfileType = crmTypes.slice(
    crmTypes.indexOf("export type BuyerSearchProfile"),
    crmTypes.indexOf("export type CrmPipeline"),
  );

  assert.match(profiles, /profile\.owner_user_id as "ownerUserId"/);
  assert.match(profiles, /ownerUserId: row\.ownerUserId \?\? undefined/);
  assert.match(buyerProfileType, /ownerUserId\?: ID/);
});

test("paginated property reads reject dormant or flagless PPP rows", () => {
  const source = functionSource("buildSellerListingWhereClause");

  assert.match(source, /options\.allowProjectEditGrants === true/);
  assert.match(source, /scoped_permission\.can_edit_deals = true/);
  assert.match(source, /projectEditParameter/);
  assert.match(source, /scoped_customer_access\.status = 'active'/);
  assert.match(source, /scoped_customer_access\.can_view_project = true/);
  assert.match(propertyRouteSource, /canUseBrokerProjectEditScope/);
  assert.match(propertyRouteSource, /allowProjectEditGrants: canUseBrokerProjectEditScope\(auth\.session\)/);
});

test("restricted core payload gates privileged collections and scopes project metadata", () => {
  const source = functionSource("applyActorAuxiliaryScope");

  assert.match(source, /hasProductCapability\(session\.productRole, "funnels:publish"\)/);
  assert.match(source, /funnel\.ownerUserId === session\.userId/);
  assert.match(source, /projectScope\.editableProjectIds\.has\(funnel\.projectId\)/);
  assert.match(source, /visibleFunnelIds\.has\(step\.funnelId\)/);
  assert.match(source, /hasProductCapability\(session\.productRole, "newsletter:send"\)/);
  assert.match(source, /hasProductCapability\(session\.productRole, "bots:publish"\)/);
  assert.match(source, /run\.createdByUserId === session\.userId/);
  assert.match(source, /canReadEditorPreflightType\(session, run\.editorType\)/);
  assert.match(source, /visiblePipelineIds\.has\(stage\.pipelineId\)/);
});

test("core GET and page render are read-only and never bootstrap pipelines", () => {
  assert.doesNotMatch(coreRouteSource, /ensureWorkspaceProjectDefaultPipelines/);
  assert.doesNotMatch(homePageSource, /ensureWorkspaceProjectDefaultPipelines/);
});
