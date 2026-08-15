#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  runNotificationTestSinkProbe,
  validateNotificationTargetReadiness,
  validateNotificationTestSinkUrl,
} from "../src/lib/notifications/provider-target-readiness.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function googleTarget(overrides = {}) {
  return {
    alertTypes: ["lead_sla_overdue"],
    destinationType: "google_chat_webhook",
    enabled: true,
    projectId,
    webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=key-value&token=token-value",
    workspaceId,
    ...overrides,
  };
}

function teamsTarget(overrides = {}) {
  return {
    alertTypes: ["lead_sla_overdue"],
    destinationType: "incoming_webhook",
    enabled: true,
    projectId,
    webhookUrl: "https://example.webhook.office.com/webhookb2/opaque-provider-path",
    workspaceId,
    ...overrides,
  };
}

test("provider readiness validates workspace, project, alert scope, destination and credential before enqueue", () => {
  for (const [provider, target] of [["google", googleTarget()], ["teams", teamsTarget()]]) {
    assert.deepEqual(
      validateNotificationTargetReadiness({
        alertType: "lead_sla_overdue",
        projectId,
        provider,
        target,
        workspaceId,
      }),
      { health: "configured", ok: true, provider },
    );
  }

  const cases = [
    [null, "target_missing"],
    [googleTarget({ enabled: false }), "target_disabled"],
    [googleTarget({ workspaceId: "44444444-4444-4444-8444-444444444444" }), "target_workspace_mismatch"],
    [googleTarget({ projectId: "55555555-5555-4555-8555-555555555555" }), "target_project_mismatch"],
    [googleTarget({ alertTypes: ["meeting_booked"] }), "alert_scope_missing"],
    [googleTarget({ destinationType: "space" }), "destination_unsupported"],
    [googleTarget({ webhookUrl: null }), "credential_missing"],
    [googleTarget({ webhookUrl: "https://attacker.example.test/webhook" }), "credential_invalid"],
  ];

  for (const [target, code] of cases) {
    const result = validateNotificationTargetReadiness({
      alertType: "lead_sla_overdue",
      projectId,
      provider: "google",
      target,
      workspaceId,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.retryable, false);
    assert.ok(result.adminAction.length > 20);
  }

  assert.equal(
    validateNotificationTargetReadiness({
      alertType: "lead_sla_overdue",
      projectId,
      provider: "teams",
      target: teamsTarget({ webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=x&token=y" }),
      workspaceId,
    }).ok,
    false,
  );
  assert.equal(
    validateNotificationTargetReadiness({
      alertType: "lead_sla_overdue",
      projectId,
      provider: "teams",
      target: teamsTarget({
        webhookUrl: "https://default.eu.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/opaque/triggers/manual/paths/invoke?sig=opaque",
      }),
      workspaceId,
    }).ok,
    true,
  );
  assert.equal(
    validateNotificationTargetReadiness({
      alertType: "lead_sla_overdue",
      projectId,
      provider: "teams",
      target: teamsTarget({
        webhookUrl: "https://prod-01.westeurope.logic.azure.com/workflows/opaque/triggers/manual/paths/invoke",
      }),
      workspaceId,
    }).ok,
    false,
  );
});

test("health and reconnect probes can call only a dedicated test sink", async () => {
  assert.equal(validateNotificationTestSinkUrl({ value: googleTarget().webhookUrl }).ok, false);
  assert.equal(validateNotificationTestSinkUrl({ value: teamsTarget().webhookUrl }).ok, false);
  assert.equal(validateNotificationTestSinkUrl({ value: "http://qa-sink.example.test/probe" }).ok, false);

  const calls = [];
  const result = await runNotificationTestSinkProbe({
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      return new Response(null, { status: 204 });
    },
    provider: "google",
    sinkUrl: "https://qa-sink.example.test/notification-probe",
    targetId,
  });

  assert.deepEqual(result, { mode: "test_sink", ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qa-sink.example.test/notification-probe");
  assert.doesNotMatch(calls[0].url, /googleapis|office\.com|logic\.azure|powerplatform/u);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    probe: "novalure_notification_test_sink_v1",
    provider: "google",
    targetId,
  });
});

test("queue idempotency never requeues a blocked job and worker preflight precedes the lease", async () => {
  const [google, teams] = await Promise.all([
    read("src/lib/db/google-notification-repositories.ts"),
    read("src/lib/db/teams-notification-repositories.ts"),
  ]);

  for (const [provider, source] of [["google", google], ["teams", teams]]) {
    const queueStart = source.indexOf(`export async function queue${provider === "google" ? "Google" : "Teams"}Notification`);
    const queueEnd = source.indexOf("export async function queue", queueStart + 30);
    const queueSource = source.slice(queueStart, queueEnd > queueStart ? queueEnd : source.length);
    const conflictStart = queueSource.indexOf("on conflict (workspace_id, idempotency_key)");
    const returningStart = queueSource.indexOf("returning", conflictStart);
    const conflictSource = queueSource.slice(conflictStart, returningStart);

    assert.match(queueSource, /validateNotificationTargetReadiness/);
    assert.match(queueSource, /readiness\.ok \? "queued" : "pending_config"/);
    assert.match(queueSource, /configuration_code/);
    assert.match(queueSource, /admin_action/);
    assert.doesNotMatch(conflictSource, /status\s*=/);
    assert.doesNotMatch(conflictSource, /target_id\s*=/);

    const processStart = source.indexOf(`export async function processDue${provider === "google" ? "Google" : "Teams"}Notifications`);
    const processSource = source.slice(processStart);
    assert.ok(processSource.indexOf("prepare") < processSource.indexOf("claim"));
    assert.match(processSource, /pendingConfig/);
  }
});

test("reconcile is explicit, concurrency-safe, idempotent and cannot send inline", async () => {
  const [google, teams, googleRoute, teamsRoute] = await Promise.all([
    read("src/lib/db/google-notification-repositories.ts"),
    read("src/lib/db/teams-notification-repositories.ts"),
    read("src/app/api/crm/google-notifications/[notificationId]/retry/route.ts"),
    read("src/app/api/crm/teams-notifications/[notificationId]/retry/route.ts"),
  ]);

  for (const source of [google, teams]) {
    assert.match(source, /targetId: string/);
    assert.match(source, /state: "already_reconciled"/);
    assert.match(source, /idempotency_key = \$5/);
    assert.match(source, /provider_message_id is null/);
    assert.match(source, /sent_at is null/);
    assert.match(source, /delivery_outcome_uncertain/);
    assert.match(source, /reconciliation_blocked_uncertain_delivery/);
    assert.match(source, /status in \('failed', 'pending_config', 'dead_letter'\)/);
    assert.match(source, /reconciled_by_user_id/);
    assert.match(source, /notification\.job_reconciled/);
  }

  for (const route of [googleRoute, teamsRoute]) {
    assert.match(route, /resolveWorkspaceScopedSession/);
    assert.match(route, /settings:manage/);
    assert.match(route, /targetId/);
    assert.match(route, /reconcile/);
    assert.doesNotMatch(route, /processDue/);
  }
});

test("migration leaves legacy cohorts non-retrying and enforces active qualifying assignees", async () => {
  const migration = await read("migrations/064_notification_provider_and_lead_assignee_integrity.sql");
  const hardening = await read("migrations/065_notification_guard_search_path_hardening.sql");

  assert.match(migration, /update google_notification_jobs[\s\S]*status = 'pending_config'/);
  assert.match(migration, /where status = 'failed'[\s\S]*target_id is null/);
  assert.match(migration, /update teams_notification_jobs[\s\S]*where status = 'pending_config'/);
  assert.doesNotMatch(migration, /update (?:google|teams)_notification_jobs[\s\S]{0,180}status = 'queued'/);
  assert.doesNotMatch(migration, /google_notification_job_target_guard/);
  assert.doesNotMatch(migration, /teams_notification_job_target_guard/);
  assert.doesNotMatch(migration, /leads_qualifying_requires_assignee_check/);
  assert.doesNotMatch(migration, /update leads[\s\S]*assigned_to_user_id\s*=/i);
  assert.match(hardening, /google_notification_job_target_guard/);
  assert.match(hardening, /teams_notification_job_target_guard/);
  assert.equal((hardening.match(/target\.enabled is not true/g) ?? []).length, 2);
  assert.equal((hardening.match(/not coalesce\(new\.alert_type = any\(target\.alert_types\), false\)/g) ?? []).length, 2);
  assert.match(hardening, /leads_qualifying_requires_assignee_check[\s\S]*not valid/i);
  assert.match(hardening, /new\.status <> 'Qualifizieren'/);
  assert.match(hardening, /status = 'active'/);
  assert.equal(
    (hardening.match(/set search_path = pg_catalog, public, pg_temp/g) ?? []).length,
    3,
  );
  assert.match(hardening, /public\.google_notification_targets%rowtype/);
  assert.match(hardening, /from public\.google_notification_targets/);
  assert.match(hardening, /public\.teams_notification_targets%rowtype/);
  assert.match(hardening, /from public\.teams_notification_targets/);
  assert.match(hardening, /from public\.workspace_users/);
});

test("lead service and UI block Qualifizieren without an active explicit assignee", async () => {
  const [repository, leadInbox, leadRoute] = await Promise.all([
    read("src/lib/db/crm-write-repositories.ts"),
    read("src/components/lead-inbox.tsx"),
    read("src/app/api/crm/leads/route.ts"),
  ]);

  assert.match(repository, /requireActive: status === "Qualifizieren"/);
  assert.match(repository, /Lead assignee is required for status Qualifizieren/);
  assert.match(repository, /fallbackUserId: existing \? null/);
  assert.match(repository, /status = 'active'/);
  assert.match(leadRoute, /upsertLeadRecord/);
  assert.match(leadRoute, /reason\.includes\("required"\)/);
  assert.match(leadInbox, /qualifyingAssigneeMissing/);
  assert.match(leadInbox, /fieldSaving \|\| qualifyingAssigneeMissing/);
  assert.match(leadInbox, /assignableUsers\.some/);
  assert.match(leadInbox, /restoreRequiresAssignee/);
  assert.match(leadInbox, /disabled=\{user\.status !== "active"\}/);
});
