import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("trusted-candidate property surfaces are mounted once in the command center", async () => {
  const commandCenter = await source("src/components/property-command-center.tsx");
  for (const component of [
    "PropertyCoreEditor",
    "PropertyRelationshipEditor",
    "PropertyExposeWorkspace",
    "PropertyMediaGallery",
    "PropertyDocumentReview",
  ]) {
    assert.match(commandCenter, new RegExp(component));
  }
  assert.match(commandCenter, /usePropertyWorkflowCapabilities\(context\.workspaceId\)/);
  assert.match(commandCenter, /canReview=\{workflowCapabilities\.canReviewDocuments\}/);
  assert.match(commandCenter, /canEdit=\{workflowCapabilities\.canEditProperty\}/);
  assert.doesNotMatch(commandCenter, /selectedMedia\.length \? selectedMedia\.map/);
  assert.match(await source("src/components/property-core-editor.tsx"), /PropertyPurchaseCostsInput/);
});

test("workspace refresh and actor scope are passed to restored editors", async () => {
  const workspace = await source("src/components/crm-workspace.tsx");
  assert.match(workspace, /if \(!\(await refreshCoreData\(\)\)\) throw new Error\("refresh_unavailable"\)/);
  assert.match(workspace, /draftUserId=\{sessionUserId\}/);
  assert.match(workspace, /users=\{users\}/);
});

test("property API keeps tenant scope, server capabilities, review, relationship CAS and media CAS", async () => {
  const route = await source("src/app/api/crm/properties/route.ts");
  for (const marker of [
    'resolveWorkspaceScopedSession(request, { permission: "crm:read" })',
    'readOperation === "capabilities"',
    'readOperation === "relationship_options"',
    'operation === "review_document"',
    'operation === "update_relationships"',
    "expectedMedia: input.expectedMedia",
    "projectId: input.projectId",
  ]) assert.ok(route.includes(marker), marker);
});

test("repository mutations preserve transaction wrapper and atomic comparison snapshots", async () => {
  const repository = await source("src/lib/db/property-department-repositories.ts");
  for (const marker of [
    "async function updateSellerListingRecordInTransaction",
    "hasExpectedCore",
    "hasExpectedRelationships",
    "hasExpectedAncillaryCosts",
    "queryPropertyMediaMutation",
    "withCrmRead(input.session",
  ]) assert.ok(repository.includes(marker), marker);
});

test("Exposé routes are private, tenant-scoped, and traced with their immutable assets", async () => {
  const route = await source("src/app/api/crm/properties/expose/route.ts");
  const documentRoute = await source("src/app/api/crm/properties/expose/[documentId]/route.ts");
  const config = await source("next.config.ts");
  assert.match(route, /private, no-store/);
  assert.match(route, /resolveWorkspaceScopedSession/);
  assert.match(documentRoute, /content-security-policy/);
  assert.match(config, /property-expose-assets\/\*\*\/\*/);
});

test("private media workflows use tenant transactions and an RLS-scoped runtime grant", async () => {
  const mediaRoute = await source("src/app/api/media/route.ts");
  const fileRoute = await source("src/app/api/media/files/[assetId]/route.ts");
  const deleteRoute = await source("src/app/api/media/[assetId]/route.ts");
  const migration = await source("migrations/088_property_media_runtime_access.sql");
  assert.match(mediaRoute, /withCrmRead\(auth\.session/);
  assert.match(fileRoute, /withCrmRead\(auth\.session/);
  assert.match(deleteRoute, /withCrmRead\(auth\.session/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /workspace_id = nullif\(current_setting\('app\.tenant_id'/);
  assert.match(migration, /actor\.id = nullif\(current_setting\('app\.actor_id'/);
  assert.match(migration, /grant select, insert, update, delete on table media_assets to novalure_tenant_app/);
  assert.doesNotMatch(migration, /disable row level security|no force/);
});

test("restored property audit and Exposé company data stay least-privilege", async () => {
  const migration = await source("migrations/089_property_surface_runtime_access.sql");
  const exposeRepository = await source("src/lib/db/property-expose-repositories.ts");
  assert.match(migration, /alter table property_activity_events force row level security/);
  assert.match(migration, /actor_user_id = nullif\(current_setting\('app\.actor_id'/);
  assert.match(migration, /grant select, insert on table property_activity_events to novalure_tenant_app/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(migration, /p_workspace = nullif\(current_setting\('app\.tenant_id'/);
  assert.match(migration, /revoke all on function crm_property_expose_company_profile\(uuid\) from public/);
  assert.doesNotMatch(migration, /grant select on (table )?company_profiles/i);
  assert.match(exposeRepository, /crm_property_expose_company_profile\(p\.workspace_id\)/);
  assert.doesNotMatch(exposeRepository, /from company_profiles cp/);
});
