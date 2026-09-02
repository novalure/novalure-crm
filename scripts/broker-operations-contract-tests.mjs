#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { splitPostgresStatements } from "./lib/postgres-statement-splitter.mjs";

const migration = await readFile(new URL("../migrations/081_broker_operations.sql", import.meta.url), "utf8");
const rollback = await readFile(new URL("../migrations/081_broker_operations_rollback.sql", import.meta.url), "utf8");
const repository = await readFile(new URL("../src/lib/db/broker-operations-repository.ts", import.meta.url), "utf8");
const component = await readFile(new URL("../src/components/broker-operations-panel.tsx", import.meta.url), "utf8");
const http = await readFile(new URL("../src/lib/broker-flow/http.ts", import.meta.url), "utf8");
const providerPolicy = await readFile(new URL("../src/lib/broker-flow/provider-policy.ts", import.meta.url), "utf8");
const migrationRunner = await readFile(new URL("./db-migrate.mjs", import.meta.url), "utf8");
const crmWorkspace = await readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");
const legacyRepository = await readFile(new URL("../src/lib/db/broker-entity-repositories.ts", import.meta.url), "utf8");
const crmLoaders = await readFile(new URL("../src/lib/db/crm-loaders.ts", import.meta.url), "utf8");
const legacyMandateRoute = await readFile(new URL("../src/app/api/crm/broker/mandates/route.ts", import.meta.url), "utf8");

const routePaths = ["operations", "search-profiles", "matches", "offers", "activities", "viewings", "closings"];
const routes = new Map(await Promise.all(routePaths.map(async (name) => [
  name,
  await readFile(new URL(`../src/app/api/crm/broker/${name}/route.ts`, import.meta.url), "utf8"),
])));

test("migration 081 is additive and contains the complete provider-safe broker data contract", () => {
  assert.ok(splitPostgresStatements(migration).length > 20);
  assert.doesNotMatch(migration, /\btruncate\b|\bdrop\s+table\b|\bdelete\s+from\b/iu);
  for (const table of [
    "broker_operation_requests",
    "buyer_match_evaluations",
    "buyer_match_decisions",
    "broker_offers",
    "broker_offer_items",
    "broker_offer_versions",
    "broker_offer_deliveries",
    "broker_viewing_history",
    "broker_closings",
    "broker_closing_participants",
    "broker_commission_splits",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(migration, /foreign key \(workspace_id, search_profile_id\)/);
  assert.match(migration, /foreign key \(workspace_id, seller_listing_id\)/);
  assert.match(migration, /foreign key \(workspace_id, unit_id\)/);
  assert.match(migration, /net_commission_minor \+ tax_minor = gross_commission_minor/);
  assert.match(migration, /buyer_commission_minor \+ seller_commission_minor = gross_commission_minor/);
  assert.match(migration, /gross_commission_minor <= base_amount_minor/);
  assert.match(migration, /broker_commission_splits_recipient_check/);
  assert.match(migration, /side in \('buyer', 'seller', 'referral'\)/);
  assert.match(migration, /source_side in \('buyer', 'seller'\)/);
  assert.match(migration, /status = 'accepted' and provider_receipt_id is not null and accepted_at is not null/);
  assert.match(migration, /alter column unit_id drop not null/);
  assert.match(migration, /broker_operations_managed/);
  assert.match(migration, /actor_user_id uuid not null/);
  assert.match(migration, /unique \(workspace_id, actor_user_id, idempotency_key\)/);
  assert.match(migration, /alter table public\.%I force row level security/);
  assert.match(migration, /broker_operation_requests_actor_policy/);
  assert.match(migration, /array\['novalure_app', 'novalure_tenant_app'\]/);
  const constraintExistenceChecks = [
    ...migration.matchAll(/if not exists \(select 1 from pg_constraint where ([^)]+)\) then/giu),
  ];
  assert.equal(constraintExistenceChecks.length, 42);
  assert.ok(
    constraintExistenceChecks.every(([, predicate]) =>
      /conrelid = 'public\.(?:buyer_search_profiles|property_viewing_slots|contact_timeline_items|tasks)'::regclass/iu.test(predicate)
        && /conname = '[a-z0-9_]+'/iu.test(predicate),
    ),
    "every idempotent constraint lookup must bind both the table OID and constraint name",
  );
});

test("rollback is explicitly Preview-only and refuses silent data loss", () => {
  assert.match(rollback, /current_setting\('novalure\.environment', true\) is distinct from 'preview'/);
  assert.match(rollback, /current_setting\('novalure\.allow_qa_schema_rollback', true\) is distinct from 'true'/);
  assert.match(rollback, /rollback refused: table % still contains operational data/);
  assert.match(rollback, /rollback refused: buyer_search_profiles contains Broker Operations data/);
  assert.match(rollback, /rollback refused: property_viewing_slots contains Broker Operations data/);
  assert.doesNotMatch(rollback, /\btruncate\b/iu);
  assert.match(rollback, /alter column unit_id set not null/);
  assert.match(rollback, /delete from public\.novalure_schema_migrations where version = \$1/);
  assert.match(migrationRunner, /"081_broker_operations"[\s\S]*"035_property_department_content"/);
});

test("every mutation route uses workspace auth, CSRF-bearing helpers and required idempotency", () => {
  for (const [name, route] of routes) {
    assert.match(route, /authorizeBrokerRead/);
    assert.match(route, /authorizeBrokerWrite/);
    assert.match(route, /readBrokerMutation/);
    assert.match(route, /export const runtime = "nodejs"/);
    assert.match(route, /brokerErrorResponse/);
    assert.match(route, /pagination|parsePagination/, `${name} must expose pagination`);
  }
  assert.match(http, /resolveWorkspaceScopedSession/);
  assert.match(http, /permission: "crm:write", capability: "pipeline:write"/);
  assert.match(http, /requireIdempotencyKey/);
});

test("search-profile QA writes register their reset root inside the idempotent tenant transaction", () => {
  const wrapperSection = repository.slice(
    repository.indexOf("async function withIdempotentMutation"),
    repository.indexOf("async function assertProject"),
  );
  const profileSection = repository.slice(
    repository.indexOf("export async function saveBrokerSearchProfile"),
    repository.indexOf("type CandidateRow"),
  );
  const profileRoutes = [routes.get("operations"), routes.get("search-profiles")];

  assert.match(wrapperSection, /assertQaBatchForMutation\(transaction/);
  assert.match(wrapperSection, /assertQaBatchOwnsObject\(transaction/);
  assert.match(wrapperSection, /registerQaBatchObjectsWithOwnershipGuard\(transaction/);
  assert.match(wrapperSection, /preExistingObjects: \[object\]/);
  assert.ok(
    wrapperSection.indexOf("assertQaBatchForMutation(transaction")
      < wrapperSection.indexOf("const claimed = await transaction.queryOne"),
    "the QA batch must be locked and validated before the idempotency claim",
  );
  assert.ok(
    wrapperSection.lastIndexOf("registerQaBatchObjectsWithOwnershipGuard(transaction")
      < wrapperSection.indexOf("update broker_operation_requests"),
    "the reset root and idempotency receipt must commit in one transaction",
  );
  assert.match(profileSection, /qaBatchId\?: string/);
  assert.match(profileSection, /objectType: "buyer_search_profiles"/);
  assert.match(http, /readQaBatchMutationHeader\(request, session\)/);
  assert.match(http, /qaBatchRuntimeErrorResponse\(error\)/);
  assert.match(http, /QA_BATCH_MUTATION_NOT_ATOMIC/);
  for (const route of profileRoutes) {
    assert.match(route, /readBrokerMutation\(request, auth\.session, \{ qaBatchSupported: true \}\)/);
    assert.match(route, /qaBatchId: mutation\.qaBatchId \?\? undefined/);
    assert.match(route, /qaBatchSuccessHeaders\(mutation\.qaBatchId, result\.qaBatchRegistration\)/);
  }
  for (const name of ["activities", "closings", "matches", "offers", "viewings"]) {
    assert.match(routes.get(name), /readBrokerMutation\(request, auth\.session\)/);
    assert.doesNotMatch(routes.get(name), /qaBatchSupported: true/);
  }
});

test("repository mutations are tenant-context transactional, OCC-protected and audited", () => {
  assert.match(repository, /withTenantTransaction/);
  assert.match(repository, /tenantQuery/);
  assert.doesNotMatch(repository, /withDatabaseTransaction|queryRows/);
  assert.match(repository, /actorId: input\.session\.userId/);
  assert.match(repository, /broker_operation_requests/);
  assert.match(repository, /on conflict \(workspace_id, actor_user_id, idempotency_key\)/);
  assert.match(repository, /for update/);
  assert.match(repository, /version = version \+ 1/);
  assert.match(repository, /writeAuditLog\(\{/);
  assert.match(repository, /where workspace_id = \$1::uuid/);
  assert.match(repository, /Idempotency-Key was already used for a different request/);
  assert.match(repository, /project_scope_mismatch/);
  assert.match(repository, /record_scope_forbidden/);
  assert.match(repository, /project_pipeline_permissions/);
  assert.match(repository, /reference_scope_forbidden/);
  assert.match(legacyRepository, /permission\.can_edit_deals = true/);
  assert.match(legacyRepository, /canViewAllWorkspaceContacts\(session\)/);
  assert.ok((repository.match(/canViewAllWorkspaceContacts\(input\.session\)/g) ?? []).length >= 6);
  assert.match(repository, /assertInitialState/);
  assert.match(repository, /assertMutableState/);
});

test("search-profile project assignment and matching require locked explicit project-edit scope", () => {
  const saveProfileSection = repository.slice(
    repository.indexOf("export async function saveBrokerSearchProfile"),
    repository.indexOf("type CandidateRow"),
  );
  const calculateMatchesSection = repository.slice(
    repository.indexOf("async function calculateMatches"),
    repository.indexOf("export async function listLiveBrokerMatches"),
  );

  assert.match(repository, /async function assertBrokerProjectEditAccess/);
  assert.match(repository, /from project_pipeline_permissions[\s\S]*limit 1[\s\S]*for share/);
  assert.match(
    saveProfileSection,
    /if \(!existing \|\| existing\.projectId !== profile\.projectId\) \{[\s\S]*assertBrokerProjectEditAccess/,
  );
  assert.match(calculateMatchesSection, /from buyer_search_profiles[\s\S]*for share/);
  assert.match(calculateMatchesSection, /assertBrokerProjectEditAccess/);
});

test("broker creates and project moves require target-project scope and preserve non-manager ownership", () => {
  const accessSection = repository.slice(
    repository.indexOf("async function assertBrokerRecordAccess"),
    repository.indexOf("type BrokerOwnedReference"),
  );
  const offerSection = repository.slice(
    repository.indexOf("export async function saveBrokerOffer"),
    repository.indexOf("export async function requestBrokerOfferQaDelivery"),
  );
  const activitySection = repository.slice(
    repository.indexOf("export async function createBrokerActivity"),
    repository.indexOf("type ViewingRow"),
  );
  const viewingSection = repository.slice(
    repository.indexOf("export async function saveBrokerViewing"),
    repository.indexOf("type ClosingRow"),
  );

  assert.match(accessSection, /ownerAssignmentAllowed/);
  assert.match(accessSection, /owner_reassignment_forbidden/);
  assert.match(
    accessSection,
    /input\.existingOwnerUserId === undefined[\s\S]*input\.desiredOwnerUserId === input\.session\.userId[\s\S]*input\.desiredOwnerUserId === input\.existingOwnerUserId/,
  );
  for (const mutationSection of [offerSection, viewingSection]) {
    assert.match(
      mutationSection,
      /if \(existing\) \{[\s\S]*existingOwnerUserId: existing\.ownerUserId[\s\S]*projectId: existing\.projectId/,
    );
    assert.match(
      mutationSection,
      /if \(!existing \|\| existing\.projectId !== projectId\) \{[\s\S]*assertBrokerProjectEditAccess\(\{[\s\S]*projectId/,
    );
    assert.ok(
      mutationSection.indexOf("projectId: existing.projectId") < mutationSection.indexOf("if (!existing || existing.projectId !== projectId)"),
      "the existing record scope must be checked before target-project authorization",
    );
  }
  assert.match(
    activitySection,
    /assertProject\(transaction, input\.session, projectId\);[\s\S]*assertBrokerProjectEditAccess\(\{[\s\S]*projectId[\s\S]*assertBrokerRecordAccess/,
  );
});

test("match decisions and QA delivery re-check locked project authorization", () => {
  const decisionSection = repository.slice(
    repository.indexOf("export async function saveBrokerMatchDecision"),
    repository.indexOf("type OfferRow"),
  );
  const deliverySection = repository.slice(
    repository.indexOf("export async function requestBrokerOfferQaDelivery"),
    repository.indexOf("export async function listBrokerActivities"),
  );

  assert.match(decisionSection, /from buyer_search_profiles[\s\S]*for share/);
  assert.match(decisionSection, /assertBrokerRecordAccess[\s\S]*assertBrokerProjectEditAccess[\s\S]*assertReference/);
  assert.match(deliverySection, /from broker_offers[\s\S]*for update/);
  assert.match(deliverySection, /assertBrokerRecordAccess[\s\S]*assertBrokerProjectEditAccess[\s\S]*offer\.status !== "ready"/);
});

test("legacy mandate API is actor-scoped for reads and fail-closed for direct writes", () => {
  const mandateLoaderSection = crmLoaders.slice(
    crmLoaders.indexOf("export async function loadBrokerMandates"),
    crmLoaders.indexOf("export async function loadBuyerSearchProfiles"),
  );

  assert.match(legacyMandateRoute, /loadBrokerMandates\(auth\.session\)/);
  assert.match(legacyMandateRoute, /legacy_mandate_write_disabled/);
  assert.match(legacyMandateRoute, /persisted: false/);
  assert.match(legacyMandateRoute, /private, no-store/);
  assert.match(legacyMandateRoute, /status: 410/);
  assert.doesNotMatch(legacyMandateRoute, /upsertBrokerMandate|request\.json\(/);
  assert.match(mandateLoaderSection, /withTenantTransaction/);
  assert.match(mandateLoaderSection, /seller_lead\.assigned_to_user_id = \$3::uuid/);
  assert.match(mandateLoaderSection, /mandate_contact\.owner_user_id = \$3::uuid/);
  assert.match(mandateLoaderSection, /canUseBrokerProjectEditScope\(session\)/);
  assert.match(mandateLoaderSection, /permission\.can_edit_deals = true/);
});

test("core buyer search profiles are session-scoped and fail closed without an actor", () => {
  const coreLoaderSection = crmLoaders.slice(
    crmLoaders.indexOf("export async function getCoreCrmData"),
    crmLoaders.indexOf("function mapProjectRow"),
  );
  const profileLoaderSection = crmLoaders.slice(
    crmLoaders.indexOf("export async function loadBuyerSearchProfiles"),
    crmLoaders.indexOf("export async function loadPropertyBuildings"),
  );

  assert.match(
    coreLoaderSection,
    /options\.session \? loadBuyerSearchProfiles\(options\.session\) : Promise\.resolve\(\[\]\)/,
  );
  assert.match(profileLoaderSection, /withTenantTransaction/);
  assert.match(profileLoaderSection, /profile\.owner_user_id = \$3::uuid/);
  assert.match(profileLoaderSection, /buyer_lead\.assigned_to_user_id = \$3::uuid/);
  assert.match(profileLoaderSection, /buyer_contact\.owner_user_id = \$3::uuid/);
  assert.match(profileLoaderSection, /canUseBrokerProjectEditScope\(session\)/);
  assert.match(profileLoaderSection, /permission\.can_edit_deals = true/);
});

test("offer and viewing provider states cannot claim unverified success", () => {
  assert.match(repository, /evaluateQaOfferDelivery/);
  assert.match(repository, /providerAccepted: false/);
  assert.match(repository, /externalCommunication: false/);
  assert.match(repository, /blocked_provider_unavailable/);
  assert.doesNotMatch(repository, /fetch\s*\(/);
  assert.match(providerPolicy, /provider_adapter_unavailable/);
  assert.match(providerPolicy, /No approved offer delivery adapter is installed/);
});

test("closing implementation never mutates launch-off unit, reservation or deal relationships", () => {
  const closingSection = repository.slice(repository.indexOf("export async function saveBrokerClosing"));
  assert.doesNotMatch(closingSection, /update\s+(?:public\.)?property_units/iu);
  assert.doesNotMatch(closingSection, /update\s+(?:public\.)?property_reservations/iu);
  assert.doesNotMatch(closingSection, /update\s+(?:public\.)?deals/iu);
  assert.match(closingSection, /Deliberately no property_units, property_reservations or deals update/);
});

test("BrokerOperationsPanel exports the agreed isolated integration surface and truthful controls", () => {
  assert.match(component, /export type BrokerOperationsPanelProps/);
  assert.match(component, /export function BrokerOperationsPanel/);
  for (const prop of ["projectId", "workspaceId", "contactId", "leadId", "canManage", "language", "className", "initialSelectedClosingId", "initialTab"]) {
    assert.match(component, new RegExp(`${prop}\\??:`));
  }
  assert.match(component, /csrfFetch/);
  assert.match(component, /Idempotency-Key/);
  assert.match(component, /provider did not accept|Provider hat nicht angenommen/);
  assert.match(component, /min-h-11/);
  assert.doesNotMatch(component, /reservation/i);
  assert.match(component, /projectId\s*}\)/);
  assert.match(component, /params\.set\("closingId", initialSelectedClosingId\)/);
  assert.match(component, /selectedClosingRef\.current\?\.focus\(\)/);
  assert.match(component, /selectedClosingRef\.current\?\.scrollIntoView/);
  assert.match(component, /aria-current=\{selected \? "true" : undefined\}/);
  assert.match(repository, /\$5::uuid is null or id = \$5::uuid/);
  assert.match(crmWorkspace, /initialSelectedClosingId=\{deepLinkedEntity\?\.entityType === "closing"/);
  assert.match(crmWorkspace, /initialTab=\{deepLinkedEntity\?\.entityType === "closing" \? "closings" : "profiles"\}/);
  assert.match(crmWorkspace, /key={`\$\{activeWorkspace\.id}:\$\{activeProject\.id}:\$\{deepLinkedEntity\?\.entityType === "closing"/);
});
