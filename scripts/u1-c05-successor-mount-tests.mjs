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
