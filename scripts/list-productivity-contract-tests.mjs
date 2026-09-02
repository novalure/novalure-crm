import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normalizeTags,
  requiresPrivilegedBulkRole,
  sanitizeSavedViewState,
  validateBulkAction,
} from "../src/lib/list-productivity.ts";

const ids = {
  contact: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
};

test("destructive bulk actions require an exact confirmation count", () => {
  const rejected = validateBulkAction({
    action: "archive",
    entityIds: [ids.contact],
    entityType: "contact",
    payload: { confirmedCount: 2 },
    projectId: ids.project,
  });
  assert.equal(rejected.ok, false);

  const accepted = validateBulkAction({
    action: "archive",
    entityIds: [ids.contact],
    entityType: "contact",
    payload: { confirmedCount: 1 },
    projectId: ids.project,
  });
  assert.equal(accepted.ok, true);

  const pausedWithoutConfirmation = validateBulkAction({
    action: "pause_portal",
    entityIds: [ids.contact],
    entityType: "property",
    payload: {},
    projectId: ids.project,
  });
  assert.equal(pausedWithoutConfirmation.ok, false);

  const pausedWithConfirmation = validateBulkAction({
    action: "pause_portal",
    entityIds: [ids.contact],
    entityType: "property",
    payload: { confirmedCount: 1 },
    projectId: ids.project,
  });
  assert.equal(pausedWithConfirmation.ok, true);
});

test("selection IDs are unique, bounded and action/entity combinations are allowlisted", () => {
  assert.equal(validateBulkAction({
    action: "pause_portal",
    entityIds: [ids.contact],
    entityType: "contact",
    payload: {},
  }).ok, false);
  assert.equal(validateBulkAction({
    action: "archive",
    entityIds: [ids.contact],
    entityType: "task",
    payload: { confirmedCount: 1 },
  }).ok, false);
  assert.equal(validateBulkAction({
    action: "assign_owner",
    entityIds: [ids.contact, ids.contact],
    entityType: "contact",
    payload: { ownerUserId: ids.owner },
  }).ok, false);
  assert.equal(requiresPrivilegedBulkRole("assign_owner"), true);
  assert.equal(requiresPrivilegedBulkRole("add_tags"), false);
});

test("tags and saved-view state are bounded and strip unknown values", () => {
  assert.deepEqual(normalizeTags([" Wien ", "Wien", "VIP"]), ["Wien", "VIP"]);
  assert.deepEqual(sanitizeSavedViewState({
    direction: "asc",
    filters: { status: ["active", "active"], "bad.key": ["secret"] },
    page: 999,
    pageSize: 500,
    query: "  Villa   Wien  ",
    sort: "updatedAt",
    unsafe: "ignored",
  }), {
    direction: "asc",
    filters: { status: ["active"] },
    pageSize: 100,
    query: "Villa Wien",
    sort: "updatedAt",
  });
});

test("migration extends the existing batch ledger with idempotency and exact item evidence", () => {
  const sql = readFileSync(new URL("../migrations/083_list_productivity_controls.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../migrations/083_list_productivity_controls_rollback.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table crm_bulk_runtime_batches/i);
  assert.match(sql, /crm_bulk_runtime_batches_idempotency_uidx/i);
  assert.match(sql, /workspace_id, actor_user_id, idempotency_key/i);
  assert.match(sql, /add column if not exists request_sha256 text/i);
  assert.match(sql, /crm_bulk_runtime_batches_request_sha256_check/i);
  assert.match(sql, /alter table crm_bulk_runtime_batches enable row level security/i);
  assert.match(sql, /crm_bulk_runtime_batches_runtime_policy[\s\S]*actor_user_id = nullif\(current_setting\('app\.actor_id'/i);
  assert.match(sql, /create table if not exists crm_bulk_runtime_batch_items/i);
  assert.match(sql, /parent_batch\.actor_user_id = nullif\(current_setting\('app\.actor_id'/i);
  assert.match(sql, /crm_saved_views_workspace_project_fk/i);
  assert.match(sql, /crm_recent_records_workspace_user_fk/i);
  assert.match(rollback, /novalure\.environment'[\s\S]*is distinct from 'preview'/i);
  assert.match(rollback, /novalure\.allow_qa_schema_rollback'[\s\S]*is distinct from 'true'/i);
  assert.match(rollback, /relforcerowsecurity[\s\S]*later or pre-existing batch-ledger RLS cutover/i);
  assert.ok(rollback.indexOf("novalure.allow_qa_schema_rollback") < rollback.indexOf("drop table if exists public.crm_bulk_runtime_batch_items"));
  assert.match(rollback, /delete from public\.novalure_schema_migrations where version = \$1[\s\S]*using '083_list_productivity_controls'/i);
  assert.doesNotMatch(rollback, /alter table seller_listings[\s\S]*drop column if exists metadata/i);
});

test("bulk route requires CSRF-aware workspace auth and idempotency", () => {
  const route = readFileSync(new URL("../src/app/api/crm/productivity/bulk-actions/route.ts", import.meta.url), "utf8");
  assert.match(route, /resolveWorkspaceScopedSession/);
  assert.match(route, /idempotency-key/);
  assert.match(route, /requiresPrivilegedBulkRole/);
  assert.doesNotMatch(route, /request\.headers\.get\(["']x-novalure-workspace-id/);
});

test("bulk repository fences own/project scope, payload reuse and saved-view entity updates", () => {
  const repository = readFileSync(new URL("../src/lib/db/list-productivity-repository.ts", import.meta.url), "utf8");
  const toolbar = readFileSync(new URL("../src/components/list-productivity-toolbar.tsx", import.meta.url), "utf8");

  assert.match(repository, /const ownerExpression = source\.ownerColumn \? `source\.\$\{source\.ownerColumn\}`/);
  assert.match(repository, /or \$\{ownerExpression\} = \$5::uuid/);
  assert.match(repository, /project_pipeline_permissions bulk_permission[\s\S]*can_edit_deals = true/i);
  assert.match(repository, /requestSha256 !== requestSha256[\s\S]*different bulk action payload/i);
  assert.match(repository, /and entity_type = \$10[\s\S]*and archived_at is null/i);
  assert.match(repository, /canViewAllWorkspaceContacts\(session\)/);
  assert.doesNotMatch(repository, /workspaceRecordManagerRoles/);
  assert.doesNotMatch(repository, /action\.action === "archive" && action\.entityType === "task"/);
  assert.match(toolbar, /pendingBulkRequest = useRef/);
  assert.match(toolbar, /pendingBulkRequest\.current\.signature !== requestSignature/);
  assert.match(toolbar, /"Idempotency-Key": idempotencyKey/);
  assert.match(toolbar, /response\.status < 500/);
});

test("productivity recents re-resolve current record access before returning stored labels", () => {
  const repository = readFileSync(new URL("../src/lib/db/list-productivity-repository.ts", import.meta.url), "utf8");
  const globalSearch = readFileSync(new URL("../src/lib/db/global-search-repository.ts", import.meta.url), "utf8");
  const recentsSection = repository.slice(
    repository.indexOf("export async function listRecentRecords"),
    repository.indexOf("export async function executeBulkAction"),
  );

  assert.match(recentsSection, /listGlobalSearchRecents/);
  assert.doesNotMatch(recentsSection, /select entity_id[\s\S]*from crm_recent_records/i);
  assert.match(globalSearch, /join candidates candidate/i);
  assert.match(globalSearch, /recent\.opened_at as "openedAt"/i);
});

test("project-scoped shared views disappear when current project grants are absent or revoked", () => {
  const repository = readFileSync(new URL("../src/lib/db/list-productivity-repository.ts", import.meta.url), "utf8");
  const section = repository.slice(
    repository.indexOf("export async function listSavedViews"),
    repository.indexOf("export async function saveSavedView"),
  );

  assert.match(section, /\(owner_user_id = \$3::uuid and is_shared = false\)/);
  assert.match(section, /is_shared = true[\s\S]*project_id is null/);
  assert.match(section, /\$5::boolean and exists[\s\S]*project_pipeline_permissions view_permission/);
  assert.match(section, /view_permission\.can_edit_deals = true/);
  assert.match(section, /customer_project_access view_access/);
  assert.match(section, /view_access\.status = 'active'/);
  assert.match(section, /view_access\.can_view_project = true/);
  assert.doesNotMatch(section, /owner_user_id = \$3::uuid or is_shared = true/);
});
