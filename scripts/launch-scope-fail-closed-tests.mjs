import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateLaunchScope,
  launchScopeDecisions,
  launchScopePolicyApproval,
  launchScopePolicyVersion,
} from "../src/lib/launch-scope.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

test("unfinished global import is absent from header, mobile, quick actions, and modal reachability", () => {
  const workspace = readProjectFile("src/components/crm-workspace.tsx");

  assert.match(workspace, /isLaunchSurfaceEnabled\("importReview"\)/);
  assert.match(workspace, /actionId === "reviewImport"\) return importLaunchEnabled/);
  assert.match(workspace, /if \(!importLaunchEnabled\) return;/);
  assert.match(workspace, /importLaunchEnabled && actionModal === "import"/);
  assert.ok((workspace.match(/\{importLaunchEnabled \? \(/g) ?? []).length >= 2);
});

test("funnel outbound webhook is server-side launch-off and cannot claim readiness", () => {
  const writeRoute = readProjectFile("src/app/api/crm/funnels/route.ts");
  const repository = readProjectFile("src/lib/db/crm-write-repositories.ts");
  const adapter = readProjectFile("src/lib/funnel-builder-adapter.ts");
  const commandCenter = readProjectFile("src/components/funnel-command-center.tsx");
  const submissionRoute = readProjectFile("src/app/api/funnels/[funnelId]/submissions/route.ts");

  assert.match(writeRoute, /evaluateLaunchScope\("funnelWebhookDelivery"\)/);
  assert.match(writeRoute, /delete launchScopedFunnel\.webhookUrl/);
  assert.match(writeRoute, /funnelWebhookDelivery: webhookScope\.allowed \? "on" : "off"/);
  assert.match(repository, /tracking = \(tracking - 'webhookUrl'\) \|\| \$\d+::jsonb/);
  assert.doesNotMatch(adapter, /webhookUrl: funnel\.webhookUrl/);
  assert.match(commandCenter, /data-funnel-webhook-launch-scope="off"/);
  assert.doesNotMatch(commandCenter, /updateSelectedFunnel\(\{ webhookUrl:/);
  assert.match(submissionRoute, /webhookDelivery: "launch_off"/);
  assert.match(submissionRoute, /webhookReady: false/);
  assert.doesNotMatch(submissionRoute, /webhookReady: Boolean\(/);
});

test("newsletter delivery is visibly and server-side launch-off until replay-safe delivery exists", () => {
  const scope = readProjectFile("src/lib/newsletter-launch-scope.ts");
  const route = readProjectFile("src/app/api/newsletter/send/route.ts");
  const commandCenter = readProjectFile("src/components/newsletter-command-center.tsx");

  assert.match(scope, /isLaunchSurfaceEnabled\("newsletterDelivery"\)/);
  assert.match(route, /if \(!newsletterDeliveryLaunchEnabled\)/);
  assert.match(route, /NEWSLETTER_DELIVERY_LAUNCH_OFF/);
  assert.match(route, /cache-control": "private, no-store"/);
  assert.doesNotMatch(route, /from:\s*(?:input|body)\./);
  assert.ok(
    (commandCenter.match(/newsletterDeliveryLaunchEnabled \? \(/g) ?? []).length >= 2,
  );
  assert.ok(
    (commandCenter.match(/data-newsletter-delivery-launch-scope="off"/g) ?? []).length >= 2,
  );
});

test("calendar provider writes are launch-off before body, database, or provider effects", () => {
  const google = readProjectFile("src/app/api/calendar/google/route.ts");
  const microsoft = readProjectFile("src/app/api/calendar/microsoft/route.ts");

  assert.equal(evaluateLaunchScope("calendarProviderMutation").allowed, false);

  for (const [route, providerCall] of [
    [google, "syncGoogleCalendarEvent({"],
    [microsoft.slice(microsoft.indexOf("export async function POST")), "syncMicrosoftCalendarEvent({"],
  ]) {
    const guard = route.indexOf('evaluateLaunchScope("calendarProviderMutation")');

    assert.ok(guard >= 0);
    assert.ok(guard < route.indexOf("readJson(request)"));
    assert.ok(guard < route.indexOf(providerCall));
    assert.ok(guard < route.indexOf("insertCalendarSyncEvent({"));
    assert.match(route, /calendar_provider_mutation_launch_off/);
    assert.match(route, /"Cache-Control": "private, no-store"/);
  }

  const microsoftGet = microsoft.slice(
    microsoft.indexOf("export async function GET"),
    microsoft.indexOf("export async function POST"),
  );
  assert.doesNotMatch(microsoftGet, /evaluateLaunchScope|upsertProviderConnection/);
  assert.match(microsoftGet, /listCalendarSyncEvents/);
});

test("inbound Bot channel processing is launch-off before body, database, LLM or provider work", () => {
  const route = readProjectFile("src/app/api/bots/channels/webhook/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const guard = post.indexOf('evaluateLaunchScope("botChannelInboundProcessing")');

  assert.equal(evaluateLaunchScope("botChannelInboundProcessing").allowed, false);
  assert.ok(guard >= 0);
  for (const effect of [
    "readLimitedWebhookBody(request)",
    "normalizeIncomingBotMessages(body)",
    "processNormalizedWebhookEvent({",
  ]) {
    assert.ok(guard < post.indexOf(effect), `inbound Bot guard must precede ${effect}`);
  }
  assert.match(post, /launch_scope_blocked/);
  assert.match(post, /jsonWebhookResponse\(correlationId, 503/);
});

test("OAuth, booking confirmation and bot confirmation cannot bypass calendar provider launch-off", () => {
  const oauthStart = readProjectFile("src/app/api/meetings/oauth/[provider]/start/route.ts");
  const oauthCallback = readProjectFile("src/app/api/meetings/oauth/[provider]/callback/route.ts");
  const oauthDisconnect = readProjectFile("src/app/api/meetings/oauth/[provider]/disconnect/route.ts");
  const oauthStatus = readProjectFile("src/app/api/meetings/oauth/status/route.ts");
  const bookingConfirm = readProjectFile("src/app/api/meetings/bookings/[bookingId]/confirm/route.ts");
  const botActions = readProjectFile("src/app/api/bots/actions/route.ts");
  const meetingRepository = readProjectFile("src/lib/db/meeting-repositories.ts");
  const googleAdapter = readProjectFile("src/lib/integrations/google-calendar.ts");
  const microsoftAdapter = readProjectFile("src/lib/integrations/microsoft-calendar.ts");

  for (const [source, effects] of [
    [oauthStart, ["createOAuthState({"]],
    [oauthCallback, ["consumeOAuthState({", "exchangeOAuthCode({", "upsertCalendarOAuthConnection({"]],
    [oauthDisconnect, ["disconnectCalendarOAuthConnection({"]],
    [bookingConfirm, ["confirmMeetingBooking({"]],
  ]) {
    const guard = source.indexOf('evaluateLaunchScope("calendarProviderMutation")');
    assert.ok(guard >= 0);
    for (const effect of effects) assert.ok(guard < source.indexOf(effect));
    assert.match(source, /calendar_provider_mutation_launch_off/);
    assert.match(source, /"Cache-Control": "private, no-store"/);
  }

  const botConfirm = botActions.slice(botActions.indexOf('if (type === "meeting_booking"'));
  const botGuard = botConfirm.indexOf('evaluateLaunchScope("calendarProviderMutation")');
  assert.ok(botGuard >= 0);
  assert.ok(botGuard < botConfirm.indexOf("queryOne<BotMeetingBookingRow>"));
  assert.ok(botGuard < botConfirm.indexOf("confirmMeetingBooking({"));
  assert.match(botConfirm, /calendar_provider_mutation_launch_off/);

  const centralConfirm = meetingRepository.slice(
    meetingRepository.indexOf("export async function confirmMeetingBooking"),
    meetingRepository.indexOf("function toMeetingNotificationJob"),
  );
  const centralGuard = centralConfirm.indexOf('evaluateLaunchScope("calendarProviderMutation")');
  assert.ok(centralGuard >= 0);
  for (const effect of [
    "hasDatabaseUrl()",
    "queryOne<MeetingBookingConfirmationRow>",
    "insertCalendarEventForBooking({",
    "syncMicrosoftCalendarEvent({",
    "syncGoogleCalendarEvent({",
  ]) {
    assert.ok(centralGuard < centralConfirm.indexOf(effect));
  }

  assert.doesNotMatch(oauthStatus, /evaluateLaunchScope\("calendarProviderMutation"\)/);
  assert.match(oauthStatus, /getCalendarConnectionStatus/);

  for (const [adapter, functions] of [
    [
      googleAdapter,
      [
        ["export async function syncGoogleCalendarEvent", "export async function listGoogleBusyTimes"],
        ["export async function updateGoogleCalendarEvent", "export async function deleteGoogleCalendarEvent"],
        ["export async function deleteGoogleCalendarEvent", null],
      ],
    ],
    [
      microsoftAdapter,
      [
        ["export async function syncMicrosoftCalendarEvent", "export async function listMicrosoftBusyTimes"],
        ["export async function updateMicrosoftCalendarEvent", "export async function deleteMicrosoftCalendarEvent"],
        ["export async function deleteMicrosoftCalendarEvent", null],
      ],
    ],
  ]) {
    for (const [start, end] of functions) {
      const startIndex = adapter.indexOf(start);
      const section = adapter.slice(startIndex, end ? adapter.indexOf(end, startIndex) : undefined);
      const guard = section.indexOf('evaluateLaunchScope("calendarProviderMutation")');
      const firstEffect = ["getCalendarAccessToken({", "getMicrosoftCalendarProviderStatus()", "getGraphToken(", "fetch("]
        .map((marker) => section.indexOf(marker))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];

      assert.ok(guard >= 0, `${start} must use the central provider-mutation policy`);
      assert.ok(guard < firstEffect, `${start} must fail before token or provider access`);
      assert.match(section, /calendar_provider_mutation_launch_off/);
    }
  }

  const googleBusyRead = googleAdapter.slice(
    googleAdapter.indexOf("export async function listGoogleBusyTimes"),
    googleAdapter.indexOf("export async function updateGoogleCalendarEvent"),
  );
  const microsoftBusyRead = microsoftAdapter.slice(
    microsoftAdapter.indexOf("export async function listMicrosoftBusyTimes"),
    microsoftAdapter.indexOf("export async function updateMicrosoftCalendarEvent"),
  );
  assert.doesNotMatch(googleBusyRead, /evaluateLaunchScope\("calendarProviderMutation"\)/);
  assert.doesNotMatch(microsoftBusyRead, /evaluateLaunchScope\("calendarProviderMutation"\)/);
});

test("central launch policy is versioned, unsigned, immutable and unknown surfaces fail closed", () => {
  assert.match(launchScopePolicyVersion, /^2026-08-22\./u);
  assert.equal(launchScopePolicyApproval, "PENDING_SIGNATURE");
  assert.deepEqual(evaluateLaunchScope("not-in-policy"), {
    allowed: false,
    code: "LAUNCH_SCOPE_UNKNOWN",
    decision: launchScopeDecisions.off,
    rule: {
      decision: launchScopeDecisions.off,
      reason: "The surface is absent from the versioned launch-scope policy.",
    },
  });
  assert.equal(evaluateLaunchScope("publicFormSubmission").allowed, true);
  assert.equal(evaluateLaunchScope("propertyReservationRelationshipSync").allowed, false);
  assert.equal(evaluateLaunchScope("customerCommunicationProviderMutation").allowed, false);
  assert.equal(evaluateLaunchScope("botChannelInboundProcessing").allowed, false);
  assert.equal(evaluateLaunchScope("publicFunnelVisit").allowed, false);
});

test("INTERNAL-ONLY surfaces require their exact product role and internal capability", () => {
  assert.equal(evaluateLaunchScope("systemDatabaseDiagnostics").allowed, false);
  assert.equal(
    evaluateLaunchScope("systemDatabaseDiagnostics", {
      productPermissions: ["novalure:internal"],
      productRole: "novalureAdmin",
    }).allowed,
    true,
  );
  assert.equal(
    evaluateLaunchScope("qaReset", {
      productPermissions: ["novalure:internal", "settings:manage"],
      productRole: "novalureAdmin",
    }).allowed,
    false,
  );
  assert.equal(
    evaluateLaunchScope("qaReset", {
      productPermissions: ["novalure:internal", "settings:manage"],
      productRole: "platform_admin",
    }).allowed,
    true,
  );
});

test("unapproved unit, buyer and deal synchronization is closed across UI, API, cron and repository", () => {
  const unitBoard = readProjectFile("src/components/unit-board.tsx");
  const route = readProjectFile("src/app/api/crm/reservations/route.ts");
  const cron = readProjectFile("src/app/api/cron/property-reservations/route.ts");
  const repository = readProjectFile("src/lib/db/reservation-repositories.ts");
  const unitRoute = readProjectFile("src/app/api/crm/units/route.ts");
  const unitRepository = readProjectFile("src/lib/db/property-inventory-repositories.ts");
  const recommendationRoute = readProjectFile("src/app/api/crm/recommendation-runtime/route.ts");
  const recommendationRepository = readProjectFile("src/lib/db/recommendation-runtime-repositories.ts");

  assert.match(unitBoard, /isLaunchSurfaceEnabled\([\s\S]*propertyReservationRelationshipSync/);
  assert.match(unitBoard, /data-unit-relationship-launch-scope="off"/);
  assert.match(route, /evaluateLaunchScope\("propertyReservationRelationshipSync"\)/);
  assert.ok(route.indexOf("evaluateLaunchScope") < route.indexOf("resolveWorkspaceScopedSession(request"));
  assert.match(cron, /evaluateLaunchScope\("propertyReservationRelationshipSync"\)/);
  assert.ok(cron.indexOf("evaluateLaunchScope") < cron.indexOf("expireOverduePropertyReservations({"));
  assert.ok((repository.match(/evaluateLaunchScope\("propertyReservationRelationshipSync"\)/g) ?? []).length >= 2);

  const unitPost = unitRoute.slice(unitRoute.indexOf("export async function POST"));
  const unitRouteGuard = unitPost.indexOf('evaluateLaunchScope("propertyReservationRelationshipSync")');
  assert.ok(unitRouteGuard >= 0);
  assert.ok(unitRouteGuard < unitPost.indexOf("await createPropertyUnitRecord({"));
  assert.match(unitPost, /requestedStatus && requestedStatus !== "available"/);
  assert.match(unitPost, /property_relationship_mutation_launch_off/);

  const unitWrite = unitRepository.slice(
    unitRepository.indexOf("export async function createPropertyUnitRecord"),
    unitRepository.indexOf("function cleanString"),
  );
  const unitRepositoryGuard = unitWrite.indexOf('evaluateLaunchScope("propertyReservationRelationshipSync")');
  assert.ok(unitRepositoryGuard >= 0);
  assert.ok(unitRepositoryGuard < unitWrite.indexOf("withTenantTransaction("));
  assert.match(unitWrite, /!relationshipScope\.allowed && status !== "available"/);
  assert.match(
    unitWrite,
    /status = case when \$13::boolean then excluded\.status else property_units\.status end/,
  );
  assert.doesNotMatch(unitWrite, /status = excluded\.status,/);
  const unitConflictUpdate = unitWrite.slice(
    unitWrite.indexOf("do update set"),
    unitWrite.indexOf("returning", unitWrite.indexOf("do update set")),
  );
  assert.doesNotMatch(unitConflictUpdate, /buyer_contact_id\s*=|deal_id\s*=/);

  const recommendationPost = recommendationRoute.slice(
    recommendationRoute.indexOf("export async function POST"),
  );
  const recommendationRouteGuard = recommendationPost.indexOf(
    'evaluateLaunchScope("propertyReservationRelationshipSync")',
  );
  assert.ok(recommendationRouteGuard >= 0);
  for (const effect of [
    "await upsertViewingSlot({",
    "await upsertOfferMilestone({",
    "await runAnalysisBotRecommendationCompletion({",
  ]) {
    assert.ok(recommendationRouteGuard < recommendationPost.indexOf(effect));
  }
  assert.match(recommendationPost, /property_relationship_mutation_launch_off/);

  for (const [start, end] of [
    ["export async function upsertViewingSlot", "export async function recordUnitAuditEvent"],
    ["export async function upsertOfferMilestone", "export async function runBotAnswerQualityComparison"],
    ["async function completeInventoryOperationalProof", "async function runSequenceRuntimeReview"],
    ["export async function runAnalysisBotRecommendationCompletion", "export async function runModulePermissionAudit"],
  ]) {
    const section = recommendationRepository.slice(
      recommendationRepository.indexOf(start),
      recommendationRepository.indexOf(end),
    );
    const guard = section.indexOf('evaluateLaunchScope("propertyReservationRelationshipSync")');
    assert.ok(guard >= 0, `${start} must use the central relationship policy`);
    const firstDatabaseEffect = ["canPersist()", "queryOne<", "queryRows<"]
      .map((marker) => section.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    assert.ok(guard < firstDatabaseEffect, `${start} must fail before its first database effect`);
  }

  assert.match(unitRoute, /createPropertyBuildingRecord\(\{/);
  assert.match(unitRepository, /export async function createPropertyBuildingRecord/);
});

test("internal diagnostic and QA-reset routes use the central guard in addition to local auth", () => {
  const diagnostics = readProjectFile("src/app/api/system/database/route.ts");
  const qaReset = readProjectFile("src/app/api/admin/qa-reset/route.ts");

  assert.match(diagnostics, /evaluateLaunchScope\("systemDatabaseDiagnostics", session\)/);
  assert.match(qaReset, /evaluateLaunchScope\("qaReset", session\)/);
  assert.match(qaReset, /canAdministerQaReset\(session\)/);
});
