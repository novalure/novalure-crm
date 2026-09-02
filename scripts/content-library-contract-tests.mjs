import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function transpile(file) {
  const source = read(file);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")), []);
  return result.outputText;
}

function loadContentModule() {
  const contentModule = { exports: {} };
  const output = transpile("src/lib/content-library.ts");
  new Function("require", "module", "exports", output)(require, contentModule, contentModule.exports);
  return contentModule.exports;
}

test("migration 082 keeps media_assets as tenant-qualified delete-restricted file source", () => {
  const migration = read("migrations/082_content_library_privacy.sql");
  assert.match(migration, /generated always as \(workspace_id::text\) stored/i);
  assert.match(migration, /references media_assets\(id, workspace_id\) on delete restrict/i);
  assert.match(migration, /crm_content_document_versions_immutable_update/i);
  assert.match(migration, /crm_communication_template_versions_immutable_update/i);
  assert.match(migration, /crm_content_links_validate_target/i);
  assert.doesNotMatch(migration, /\bend\s*\r?\n\$\$;/i);
  assert.match(migration, /force row level security/gi);
  assert.match(migration, /to novalure_app/i);
  assert.match(migration, /to novalure_tenant_app/i);
  assert.doesNotMatch(migration, /delete\s+from\s+media_assets/i);
  assert.doesNotMatch(migration, /crm_record_recents/i);
});

test("QA rollback removes only the additive slice and never media assets", () => {
  const rollback = read("migrations/082_content_library_privacy_rollback.sql");
  assert.match(rollback, /QA\/PREVIEW-ONLY rollback/i);
  assert.match(rollback, /^begin;[\s\S]*commit;\s*$/im);
  assert.match(rollback, /novalure\.environment[\s\S]*novalure\.allow_qa_schema_rollback/i);
  assert.match(rollback, /row_security = off/i);
  assert.match(rollback, /still contains tenant or release evidence/i);
  assert.match(rollback, /external relation[\s\S]*depends on the content\/privacy schema/i);
  assert.doesNotMatch(rollback, /drop table if exists media_assets/i);
  assert.doesNotMatch(rollback, /delete\s+from\s+public\.(?!novalure_schema_migrations)/i);
  assert.match(rollback, /drop table if exists (?:public\.)?crm_content_documents/i);
  assert.match(rollback, /082_content_library_privacy/);
});

test("template validation rejects executable syntax and escapes HTML substitutions", () => {
  const content = loadContentModule();
  assert.throws(() => content.parseCreateTemplateInput({
    name: "Unsafe",
    channel: "email",
    body: "{{{contact_name}}}",
    allowedVariables: ["contact_name"],
  }), /escaped/);
  const parsed = content.parseCreateTemplateInput({
    name: "Welcome",
    channel: "email",
    language: "de",
    body: "Hallo {{contact_name}} / {{missing}}",
    allowedVariables: ["contact_name", "missing"],
    variableFallbacks: { missing: "Team" },
  });
  const rendered = content.renderCommunicationTemplate({
    template: parsed.body,
    allowedVariables: parsed.allowedVariables,
    variableFallbacks: parsed.variableFallbacks,
    values: { contact_name: "<Franz>" },
    output: "html",
  });
  assert.equal(rendered.rendered, "Hallo &lt;Franz&gt; / Team");
  assert.deepEqual(rendered.unresolved, []);
});

test("all content mutations require auth, CSRF session resolution, idempotency and OCC", () => {
  const documents = read("src/app/api/crm/documents/route.ts");
  const document = read("src/app/api/crm/documents/[documentId]/route.ts");
  const templates = read("src/app/api/crm/templates/route.ts");
  const template = read("src/app/api/crm/templates/[templateId]/route.ts");
  for (const source of [documents, document, templates, template]) {
    assert.match(source, /resolveWorkspaceScopedSession/);
  }
  for (const source of [documents, document, templates, template]) {
    if (/export async function (POST|PATCH|DELETE)/.test(source)) assert.match(source, /parseIdempotencyKey/);
  }
  assert.match(document, /expectedUpdatedAt/);
  assert.match(template, /expectedUpdatedAt/);
  assert.match(document, /hardDeletePerformed|requestContentDocumentDeletionReview/);
});

test("content changes invalidate approval and non-managers cannot preserve or forge approval", () => {
  const repository = read("src/lib/db/content-library-repositories.ts");
  assert.match(repository, /approval_status = 'draft', approved_by_user_id = null, approved_at = null/);
  assert.match(repository, /!manager && \(input\.update\.approvalStatus === "approved" \|\| input\.update\.approvalStatus === "rejected"\)/);
  assert.match(repository, /contentChanged && before\.approvalStatus === "approved" \? "draft" : before\.approvalStatus/);
  assert.doesNotMatch(repository, /approval_status = coalesce\(\$[67], 'draft'\)/);
});

test("project content mutations re-check current write scope after locking the record", () => {
  const repository = read("src/lib/db/content-library-repositories.ts");
  const documentMutationGuard = repository.slice(
    repository.indexOf("async function documentForMutation"),
    repository.indexOf("export async function addContentDocumentVersion"),
  );
  const templateMutationGuard = repository.slice(
    repository.indexOf("async function templateForMutation"),
    repository.indexOf("export async function addCommunicationTemplateVersion"),
  );

  assert.match(documentMutationGuard, /for update of d[\s\S]*await requireProject\(input\.transaction, input\.session, document\.projectId, "write"\)/);
  assert.match(templateMutationGuard, /for update of t[\s\S]*await requireProject\(input\.transaction, input\.session, template\.projectId, "write"\)/);
});

test("document, template and media reads reject invited/suspended CPA and disabled or foreign-role PPP", () => {
  const repository = read("src/lib/db/content-library-repositories.ts");
  const accessSql = repository.slice(
    repository.indexOf("function projectPipelineEditGrantSql"),
    repository.indexOf("type ContentMediaAccessRow"),
  );
  assert.match(accessSql, /customer_access\.status = 'active'/);
  assert.match(accessSql, /customer_access\.can_view_project = true/);
  assert.match(accessSql, /customer_actor\.status = 'active'/);
  assert.match(accessSql, /content_actor\.status = 'active'/);
  assert.match(accessSql, /project_grant\.can_edit_deals = true/);
  assert.match(accessSql, /project_actor\.status = 'active'/);
  assert.match(accessSql, /project_actor\.product_role in \('developer_sales', 'project_sales_member'\)/);
  assert.match(accessSql, /internal_actor\.product_role not in \('external_partner', 'viewer'\)/);
  assert.doesNotMatch(accessSql, /owned_contact|owned_lead/);
  assert.doesNotMatch(accessSql, /status\s+in\s+\('active',\s*'invited'|status\s*<>\s*'suspended'/i);

  const documentPolicy = accessSql.slice(
    accessSql.indexOf("export function contentDocumentReadAccessSql"),
    accessSql.indexOf("function communicationTemplateReadAccessSql"),
  );
  assert.match(documentPolicy, /visibility = 'internal'[\s\S]*project_id is not null[\s\S]*projectGrant/);
  assert.match(documentPolicy, /visibility = 'customer'[\s\S]*project_id is not null[\s\S]*projectGrant[\s\S]*customerGrant/);
  assert.match(documentPolicy, /visibility = 'public'[\s\S]*project_id is null[\s\S]*projectGrant[\s\S]*customerGrant/);
  const internalBranch = documentPolicy.slice(
    documentPolicy.indexOf("visibility = 'internal'"),
    documentPolicy.indexOf("visibility = 'customer'"),
  );
  assert.doesNotMatch(internalBranch, /customerGrant|customer_project_access/);

  const documentReads = repository.slice(
    repository.indexOf("export async function listContentDocuments"),
    repository.indexOf("export async function createContentDocument"),
  );
  const templateReads = repository.slice(
    repository.indexOf("export async function listCommunicationTemplates"),
    repository.indexOf("export async function createCommunicationTemplate"),
  );
  const mediaReferences = repository.slice(
    repository.indexOf("function mediaReferenceAccessSql"),
    repository.indexOf("export async function filterAccessibleContentMediaAssetIds"),
  );
  assert.match(documentReads, /contentDocumentReadAccessSql\("d"/);
  assert.match(templateReads, /communicationTemplateReadAccessSql\("t"/);
  assert.match(mediaReferences, /contentDocumentReadAccessSql\("d", "\$2", "\$3"\)/);
  assert.match(mediaReferences, /projectPipelineEditGrantSql/);
  const propertyMediaAccess = mediaReferences.slice(
    mediaReferences.indexOf("select media.media_asset_id"),
    mediaReferences.indexOf("from property_media media"),
  );
  const propertyDocumentAccess = mediaReferences.slice(
    mediaReferences.indexOf("select document.media_asset_id"),
    mediaReferences.indexOf("from property_documents document"),
  );
  assert.match(
    propertyMediaAccess,
    /media\.visibility in \('public', 'channel'\)[\s\S]*media\.status in \('approved', 'published'\)[\s\S]*activeCustomerProjectAccessSql/,
  );
  assert.match(
    propertyDocumentAccess,
    /document\.visibility in \('public', 'channel'\)[\s\S]*document\.status in \('approved', 'sent'\)[\s\S]*activeCustomerProjectAccessSql/,
  );
  assert.equal((propertyMediaAccess.match(/activeCustomerProjectAccessSql/g) ?? []).length, 1);
  assert.equal((propertyDocumentAccess.match(/activeCustomerProjectAccessSql/g) ?? []).length, 1);
});

test("content media inherits document ACL and version references block physical deletion", () => {
  const repository = read("src/lib/db/content-library-repositories.ts");
  const component = read("src/components/content-library-panel.tsx");
  const migration = read("migrations/082_content_library_privacy.sql");
  const mediaRoute = read("src/app/api/media/route.ts");
  const mediaFileRoute = read("src/app/api/media/files/[assetId]/route.ts");
  const mediaDeleteRoute = read("src/app/api/media/[assetId]/route.ts");
  const mediaStore = read("src/lib/media-store.ts");
  const botDocumentsRoute = read("src/app/api/bots/documents/route.ts");
  const botActionsRoute = read("src/app/api/bots/actions/route.ts");
  const botChatRuntime = read("src/lib/bots/chat-runtime.ts");
  assert.match(repository, /filterAccessibleContentMediaAssetIds/);
  assert.match(repository, /canAccessContentMediaAsset/);
  assert.match(repository, /contentDocumentReadAccessSql\("d", "\$2", "\$3"\)/);
  assert.match(repository, /\$\{alias\}\.owner_user_id = \$\{actorParameter\}::uuid/);
  assert.match(repository, /\$\{alias\}\.approval_status = 'approved'/);
  assert.match(repository, /customer_project_access/);
  assert.match(repository, /project_pipeline_permissions/);
  assert.match(repository, /requireProject\(transaction, input\.session, input\.document\.projectId, "write"\)/);
  assert.match(repository, /requireContentLinkTarget\(transaction, input\.session, link\)/);
  assert.match(repository, /Document link target was not found or is outside your access scope/);
  assert.match(repository, /!input\.document\.projectId && target\.projectId/);
  assert.match(repository, /Projectless documents cannot link to project-scoped targets/);
  assert.match(repository, /filterReadableContentLinks\(transaction, input\.session, links\)/);
  const readableLinkGuard = repository.slice(
    repository.indexOf("async function canReadContentLinkTarget"),
    repository.indexOf("async function requireMediaAsset"),
  );
  assert.match(readableLinkGuard, /target\.workspace_id = \$1::uuid/);
  assert.match(readableLinkGuard, /target_access\.status = 'active'/);
  assert.match(readableLinkGuard, /target_access\.can_view_project = true/);
  assert.match(readableLinkGuard, /projectPipelineEditGrantSql\("target\.workspace_id", projectExpression, "\$3"\)/);
  assert.match(readableLinkGuard, /\(\$5::uuid is null or \$\{projectExpression\} = \$5::uuid\)/);
  assert.match(repository, /closing: \{ ownerColumn: "owner_user_id", projectColumn: "project_id", table: "broker_closings" \}/);
  assert.match(migration, /target_type in \([^)]*'closing'/);
  assert.match(migration, /when 'closing' then[\s\S]*from broker_closings/);
  assert.match(component, /contentLinkTargetTypes\.map/);
  assert.match(component, /links: linkTargetType && linkTargetId/);
  assert.match(repository, /\$3::boolean as mutable,\s+\(\$3::boolean or d\.owner_user_id = \$2::uuid\) as reusable/);
  assert.match(repository, /select coalesce\(bool_and\(reusable\), false\) from media_references/);
  assert.match(repository, /\$5::boolean = false[\s\S]*owned_contact/);
  const linkGuard = repository.slice(
    repository.indexOf("async function requireContentLinkTarget"),
    repository.indexOf("async function canReadContentLinkTarget"),
  );
  assert.match(linkGuard, /projectPipelineEditGrantSql\("target\.workspace_id", projectExpression, "\$3"\)/);
  assert.doesNotMatch(linkGuard, /customer_project_access/);
  const projectGuard = repository.slice(
    repository.indexOf("async function requireProject"),
    repository.indexOf("const linkTargetSources"),
  );
  assert.match(projectGuard, /projectPipelineEditGrantSql\("project\.workspace_id", "project\.id", "\$4"\)/);
  assert.match(mediaRoute, /filterAccessibleContentMediaAssetIds/);
  assert.doesNotMatch(mediaRoute, /canAccessContentMediaAsset\(\{ assetId, mutation: true/);
  assert.match(mediaRoute, /publishWorkspaceMedia\(assetId, auth\.session\)/);
  assert.match(mediaRoute, /revokeWorkspaceMediaPublication\(assetId, auth\.session\)/);
  assert.match(mediaRoute, /error\.code === "MEDIA_ACCESS_REQUIRED"[\s\S]*Media asset not found\.[\s\S]*status: 404/);
  assert.match(mediaFileRoute, /canAccessContentMediaAsset/);
  assert.match(mediaDeleteRoute, /canAccessContentMediaAsset\(\{ assetId, mutation: true/);
  assert.match(mediaDeleteRoute, /canManagePendingDeletion: canManageContent\(auth\.session\)/);
  assert.match(mediaDeleteRoute, /deleteWorkspaceMedia\([\s\S]*assetId,[\s\S]*auth\.session\.workspaceId,[\s\S]*auth\.session\.userId/);
  assert.match(mediaDeleteRoute, /error\.code === "METADATA_DELETE_PENDING"/);
  assert.match(mediaDeleteRoute, /pending: true/);
  assert.match(mediaStore, /from crm_content_document_versions/);
  assert.match(mediaStore, /from property_media/);
  assert.match(mediaStore, /from property_documents/);
  assert.match(mediaStore, /from bot_document_sends/);
  assert.match(mediaStore, /MEDIA_IN_USE/);
  assert.match(mediaStore, /deletion_state = 'pending'/);
  assert.match(mediaStore, /locked\.deletionRequestedByUserId !== actorId/);
  assert.match(mediaStore, /options\.canManagePendingDeletion !== true/);
  assert.match(mediaStore, /lockAuthorizedMediaPublicationAsset/);
  assert.match(mediaStore, /locked_asset as materialized[\s\S]*for update/);
  assert.match(mediaStore, /locked_project_grants as materialized[\s\S]*for share of project_grant, project_actor/);
  assert.match(mediaStore, /locked_property_media_refs as materialized[\s\S]*for share of media/);
  assert.match(mediaStore, /withTenantTransaction\(\{ actorId: session\.userId, workspaceId: session\.workspaceId \}/);
  assert.match(mediaStore, /METADATA_DELETE_PENDING/);
  assert.match(mediaStore, /createdByUserId: input\.createdByUserId/);
  assert.match(mediaStore, /created_by_user_id as "createdByUserId"/);
  assert.match(mediaStore, /created_by_user_id\s*\)\s*values[\s\S]*\$15::uuid/);
  assert.match(mediaRoute, /createdByUserId: auth\.session\.userId/);
  assert.match(repository, /asset\.created_by_user_id = \$2::uuid/);
  assert.match(repository, /asset\.deletion_state = 'pending'[\s\S]*asset\.deletion_requested_by_user_id = \$2::uuid/);
  assert.match(repository, /legacy rows without creator evidence are manager-only/i);
  assert.doesNotMatch(repository, /if \(!canPersist\(\)\) return true/);
  const propertyRepository = read("src/lib/db/property-department-repositories.ts");
  assert.equal((propertyRepository.match(/canAccessContentMediaAsset\(\{ assetId: mediaAssetId, reuse: true/g) ?? []).length, 2);
  assert.match(botDocumentsRoute, /filterAccessibleContentMediaAssetIds/);
  assert.match(botDocumentsRoute, /canAccessContentMediaAsset\(\{[\s\S]{0,120}reuse: true/);
  assert.match(botDocumentsRoute, /publishWorkspaceMedia\(asset\.id, auth\.session, \{[\s\S]{0,80}accessMode: "reuse"/);
  assert.match(botActionsRoute, /canAccessContentMediaAsset\(\{ assetId: mediaAssetId, reuse: true/);
  assert.match(botActionsRoute, /publishWorkspaceMedia\([\s\S]{0,160}auth\.session,[\s\S]{0,100}accessMode: "reuse"/);
  assert.match(botChatRuntime, /canAccessContentMediaAsset\(\{[\s\S]{0,120}reuse: true/);
  assert.match(botChatRuntime, /publishWorkspaceMedia\(input\.asset\.id, input\.session, \{[\s\S]{0,80}accessMode: "reuse"/);
  const deletionMigration = read("migrations/084_media_deletion_lifecycle.sql");
  const deletionRollback = read("migrations/084_media_deletion_lifecycle_rollback.sql");
  assert.match(deletionMigration, /novalure_require_active_content_media/);
  assert.match(deletionMigration, /deletion_state = 'active'/);
  assert.match(deletionMigration, /add column if not exists created_by_user_id uuid/);
  assert.doesNotMatch(deletionMigration, /tg_op = 'INSERT'[\s\S]{0,120}created_by_user_id is null/i);
  assert.match(deletionMigration, /creator\.workspace_id::text = new\.workspace_id/);
  assert.match(deletionMigration, /creator attribution is immutable/i);
  assert.match(deletionRollback, /^begin;[\s\S]*commit;\s*$/im);
  assert.match(deletionRollback, /pending or non-canonical media deletion evidence requires reconciliation/i);
  assert.match(deletionRollback, /media creator attribution requires reconciliation/i);
  assert.match(deletionRollback, /drop column if exists created_by_user_id/);
  assert.match(deletionRollback, /084_media_deletion_lifecycle/);
});

test("new TypeScript and TSX files are syntactically valid", () => {
  for (const file of [
    "src/lib/content-library.ts",
    "src/lib/db/content-library-repositories.ts",
    "src/app/api/crm/documents/route.ts",
    "src/app/api/crm/documents/[documentId]/route.ts",
    "src/app/api/crm/templates/route.ts",
    "src/app/api/crm/templates/[templateId]/route.ts",
    "src/components/content-library-panel.tsx",
    "src/app/api/media/route.ts",
    "src/app/api/media/[assetId]/route.ts",
    "src/app/api/media/files/[assetId]/route.ts",
  ]) transpile(file);
});
