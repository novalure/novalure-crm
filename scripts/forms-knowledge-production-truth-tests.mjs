import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("forms render database truth and never publish a local fixture or draft", async () => {
  const component = await source("src/components/form-command-center.tsx");

  assert.doesNotMatch(component, /createInitialForms|form_beratung_wohnpark|Wohnpark Graz Beratung/);
  assert.match(component, /const \[forms, setForms\] = useState<WebsiteForm\[]>\(\[\]\)/);
  assert.match(component, /const \[persistedForms, setPersistedForms\] = useState<WebsiteForm\[]>\(\[\]\)/);
  assert.match(component, /payload\.source !== "database"/);
  assert.match(component, /setPersistedForms\(normalizedForms\);\s*setForms\(normalizedForms\)/);
  assert.match(component, /setForms\(\[\]\);\s*setPersistedForms\(\[\]\);\s*setSubmissionRows\(\[\]\)/);
  assert.match(component, /data-forms-loading-state="true"/);
  assert.match(component, /data-forms-error-state="true"/);
  assert.match(component, /data-forms-empty-state="true"/);
  assert.match(component, /persistedForms\.reduce\(\(sum, form\) => sum \+ form\.submissions/);
  assert.match(
    component,
    /persistedSelectedForm[\s\S]*isPersistedFormId\(persistedSelectedForm\.id\)[\s\S]*isPublicStatus\(persistedSelectedForm\.status\)[\s\S]*persistedSelectedForm\.workspacePublicKey[\s\S]*persistedSelectedForm\.slug/,
  );
  assert.match(component, /\/api\/forms\/resolve\?form=/);
  assert.match(component, /resolverStatus === "ready" \? resolvedPublicPath : ""/);
  assert.match(component, /\{publicUrl \? \([\s\S]*data-form-publication-controls="true"/);
  assert.match(component, /result\?\.persisted !== true \|\| !result\.form \|\| !isPersistedFormId/);
  assert.match(component, /saveInFlightRef\.current/);
  assert.match(component, /"idempotency-key": saveOperationRef\.current\.id/);
  assert.match(component, /expectedVersion: selectedForm\.version \?\? 0/);
  assert.match(component, /selectedSubmissionRows\.map/);
  assert.doesNotMatch(component, /workspacePublicKey\s*\|\||relatedLeads|relatedTasks|installStatus|persistenceSource/);
});

test("forms APIs fail closed and resolver verifies tenant-owned persisted publication", async () => {
  const route = await source("src/app/api/forms/route.ts");
  const resolver = await source("src/app/api/forms/resolve/route.ts");
  const repository = await source("src/lib/db/form-repositories.ts");
  const ownerGuardMigration = await source("migrations/071_forms_owner_tenant_guard.sql");

  assert.match(route, /payload\.source !== "database" \|\| payload\.error/);
  assert.match(route, /Forms persistence unavailable[\s\S]*status: 503/);
  assert.match(route, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(route, /formEditorBodyLimits = Object\.freeze\(\{ maxBodyBytes: 256 \* 1024 \}\)/);
  assert.match(route, /readBoundedPublicSubmissionJson\(request, formEditorBodyLimits\)/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.match(route, /result\.code === "FORM_OWNER_INVALID"[\s\S]*\? 400[\s\S]*FORM_SAVE_CONFLICT[\s\S]*\? 409/);
  assert.match(resolver, /getPublicWebsiteFormByKey\(formKey\)/);
  assert.match(resolver, /persisted\.workspaceId !== auth\.session\.workspaceId/);
  assert.match(resolver, /!persisted\.publicPath/);
  assert.match(resolver, /resolved: true,[\s\S]*source: "database"/);
  assert.match(repository, /form\.status === "aktiv" \|\| form\.status === "eingebaut"/);
  assert.match(repository, /select public_key as \\"publicKey\\" from workspaces where id = \$1 limit 1/);
  assert.match(repository, /A workspace public key is required before publishing a form/);
  assert.match(repository, /lastSaveOperationId/);
  assert.match(repository, /lastSaveRequestHash/);
  assert.match(repository, /hashFormSaveRequest/);
  assert.match(repository, /coalesce\(\(previous\.previous_settings->>'version'\)::integer, 1\) = \$20::integer/);
  assert.match(repository, /on conflict \(workspace_id, slug\) do update/);
  assert.match(repository, /previous\.previous_settings->>'lastSaveOperationId' is distinct from \$19/);
  assert.match(repository, /if \(savedRow\?\.writeApplied\)/);
  const formSaveTransaction = repository.indexOf("const row = await withTenantTransaction(");
  const formSaveAudit = repository.indexOf("await writeAuditLog({", formSaveTransaction);
  const formSaveReturn = repository.indexOf("return savedRow;", formSaveTransaction);
  assert.ok(formSaveTransaction >= 0 && formSaveTransaction < formSaveAudit && formSaveAudit < formSaveReturn);
  assert.match(repository.slice(formSaveAudit, formSaveReturn), /transaction,/);
  assert.match(repository, /resolveActiveWorkspaceOwner\([\s\S]*input\.session\.workspaceId/);
  assert.match(repository, /where workspace_id = \$1::uuid[\s\S]*and id = \$2::uuid[\s\S]*and status = 'active'/);
  assert.match(repository, /form\.ownerMode !== "user"[\s\S]*FORM_OWNER_MODE_UNAVAILABLE/);
  assert.match(repository, /if \(!ownerUserId\)[\s\S]*FORM_OWNER_INVALID/);
  assert.match(ownerGuardMigration, /foreign key \(workspace_id, owner_user_id\)/);
  assert.match(ownerGuardMigration, /references public\.workspace_users\(workspace_id, id\)/);
  assert.match(ownerGuardMigration, /validate constraint forms_workspace_owner_fk/);
  assert.doesNotMatch(ownerGuardMigration, /update public\.forms|delete from/i);
  assert.doesNotMatch(ownerGuardMigration, /^\+/m);
});

test("missing public forms fail closed through the Next.js 404 boundary", async () => {
  const publicPage = await source("src/app/forms/public-form-page.tsx");
  const legacyPage = await source("src/app/forms/[slug]/page.tsx");

  assert.match(publicPage, /import \{ notFound \} from "next\/navigation"/);
  assert.equal((publicPage.match(/if \(!persisted\?\.publicPath\) notFound\(\)/g) || []).length, 2);
  assert.doesNotMatch(publicPage, /getPublicWebsiteForm\([^;]+\.catch\(/);
  assert.doesNotMatch(publicPage, /renderUnavailableFormPage|<UnavailableFormNotice/);
  assert.match(legacyPage, /import \{ notFound, redirect \} from "next\/navigation"/);
  assert.match(legacyPage, /robots: \{ follow: false, index: false \}/);
  assert.doesNotMatch(legacyPage, /getLegacyPublicWebsiteFormRoute\([^;]+\.catch\(/);
  assert.match(legacyPage, /notFound\(\)/);
});

test("livegang form QA harness uses the versioned idempotency contract", async () => {
  const harness = await source("scripts/qa-livegang-runtime.mjs");

  assert.match(harness, /import \{ randomUUID \} from "node:crypto"/);
  assert.equal((harness.match(/"Idempotency-Key": randomUUID\(\)/g) || []).length, 2);
  assert.match(harness, /json: \{ expectedVersion: 0, form \}/);
  assert.match(harness, /json: \{ expectedVersion: createdForm\.version, form: createdForm \}/);
  assert.match(harness, /archiveResponse\.response\.ok && archiveResponse\.json\?\.persisted === true/);
});

test("knowledge UI uses only persisted API rows with explicit loading error and empty states", async () => {
  const component = await source("src/components/knowledge-command-center.tsx");

  assert.match(component, /const \[persistedSources, setPersistedSources\] = useState<PreparedKnowledgeSource\[]>\(\[\]\)/);
  assert.match(component, /const sources = persistedSources/);
  assert.match(component, /data\.source !== "database" \|\| !Array\.isArray\(data\.sources\)/);
  assert.match(component, /setPersistedSources\(data\.sources\.map\(sourceFromPersisted\)\)/);
  assert.match(component, /const chunks = Math\.max\(0, Number\(source\.chunkCount\) \|\| 0\)/);
  assert.match(component, /data-knowledge-provenance="database"/);
  assert.match(component, /data-knowledge-loading-state="true"/);
  assert.match(component, /data-knowledge-error-state="true"/);
  assert.match(component, /data-knowledge-empty-state="true"/);
  assert.match(component, /data-knowledge-import-error="true"/);
  assert.match(component, /result\.persisted !== true \|\| !result\.sourceId/);
  assert.match(component, /disabled=\{isSyncing \|\| loadStatus !== "ready"\}/);
  assert.doesNotMatch(
    component,
    /preparedSources|existingSources|estimateChunks|simulateIndexing|fallbackSource|items\.map|items \* 3/,
  );
});

test("knowledge API refuses non-database success and reports only persisted identifiers", async () => {
  const [route, repository, embeddings, component] = await Promise.all([
    source("src/app/api/bots/knowledge/route.ts"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/lib/integrations/embeddings.ts"),
    source("src/components/knowledge-command-center.tsx"),
  ]);

  assert.match(route, /hasDatabaseUrl\(\) && isUuid\(workspaceId\)/);
  assert.match(route, /Knowledge persistence unavailable[\s\S]*source: "unavailable"[\s\S]*status: 503/);
  assert.match(route, /if \(!hasKnowledgePersistence\(auth\.session\.workspaceId\)\) return knowledgeUnavailable\(\)/);
  assert.match(route, /if \(!persistedSourceId\) return knowledgeUnavailable\(\)/);
  assert.match(route, /sourceId: persistedSourceId/);
  assert.match(route, /persisted: true/);
  assert.match(route, /sourceId: persistedSourceId,[\s\S]*previewResults: \[\]/);
  assert.doesNotMatch(route, /persistedSourceId \?\?|persisted: Boolean|searchKnowledgeChunks/);
  assert.match(repository, /with selected_project as \([\s\S]*inserted_source as \([\s\S]*inserted_chunks as \(/);
  assert.match(repository, /jsonb_to_recordset\([\s\S]*::jsonb\)/);
  assert.doesNotMatch(repository, /for \(const chunk of input\.chunks\)/);
  assert.match(route, /bodyBytes: 48 \* 1024/);
  assert.match(route, /chunks: 12/);
  assert.match(route, /chunkCharacters: 2_800/);
  assert.match(route, /contentCharacters: 32_000/);
  assert.match(route, /embeddingConcurrency: 3/);
  assert.match(route, /request\.body\.getReader\(\)/);
  assert.match(route, /mapWithConcurrency\([\s\S]*knowledgeRequestLimits\.embeddingConcurrency/);
  assert.doesNotMatch(route, /await Promise\.all\(\s*chunks\.map/);
  assert.match(route, /isKnowledgeProjectInWorkspace/);
  assert.match(route, /if \(!provider\.configured \|\| !provider\.external\) return knowledgeUnavailable\(\)/);
  assert.match(route, /if \(!embedding\.external\) return knowledgeUnavailable\(\)/);
  assert.match(route, /shouldEmbed && embeddedChunks\.some\(\(chunk\) => !chunk\.embeddingExternal\)/);
  assert.match(route, /chunkSize: knowledgeRequestLimits\.chunkCharacters/);
  assert.doesNotMatch(route, /reason: error instanceof Error \? error\.message/);
  assert.match(route, /reason: error instanceof KnowledgeRequestError \? error\.code : "unexpected_error"/);
  assert.match(repository, /where workspace_id = \$1::uuid[\s\S]*and id = \$2::uuid/);
  assert.match(repository, /with selected_project as \([\s\S]*workspace_id = \$1::uuid[\s\S]*where \$\{projectSql\} is null or selected_project\.id is not null/);
  assert.match(embeddings, /AbortSignal\.timeout\(EMBEDDING_PROVIDER_TIMEOUT_MS\)/);
  assert.doesNotMatch(embeddings, /reason: error instanceof Error \? error\.message/);
  assert.match(component, /maxLength=\{160\}/);
  assert.ok((component.match(/maxLength=\{32_000\}/g) ?? []).length >= 2);
});
