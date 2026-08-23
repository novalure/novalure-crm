import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateLaunchScope,
  launchScopeDecisions,
  launchScopePolicy,
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
  const googleReadGuard = googleBusyRead.indexOf('evaluateLaunchScope("calendarProviderRead")');
  const microsoftReadGuard = microsoftBusyRead.indexOf('evaluateLaunchScope("calendarProviderRead")');
  assert.ok(googleReadGuard >= 0 && googleReadGuard < googleBusyRead.indexOf("getCalendarReadAccessToken({"));
  assert.ok(microsoftReadGuard >= 0 && microsoftReadGuard < microsoftBusyRead.indexOf("getGraphToken(input.workspaceId)"));
});

test("Teams and Google notification delivery close API, cron, retry and repository effects", () => {
  for (const provider of [
    {
      apiQueue: "queueGoogleLeadSlaOverdueAlerts({",
      key: "google",
      process: "processDueGoogleNotifications({",
      queue: "queueGoogleNotification",
      reconcile: "reconcileGoogleNotificationJob({",
      rule: "googleNotificationDelivery",
      scheduled: "queueScheduledCriticalGoogleAlerts({",
    },
    {
      apiQueue: "queueLeadSlaOverdueAlerts({",
      key: "teams",
      process: "processDueTeamsNotifications({",
      queue: "queueTeamsNotification",
      reconcile: "reconcileTeamsNotificationJob({",
      rule: "teamsNotificationDelivery",
      scheduled: "queueScheduledCriticalTeamsAlerts({",
    },
  ]) {
    const api = readProjectFile(`src/app/api/crm/${provider.key}-notifications/route.ts`);
    const post = api.slice(api.indexOf("export async function POST"));
    const postGuard = post.indexOf(`evaluateLaunchScope("${provider.rule}")`);
    assert.ok(postGuard >= 0);
    for (const effect of ["resolveWorkspaceScopedSession(request", "readJson(request)", provider.apiQueue, provider.process]) {
      assert.ok(postGuard < post.indexOf(effect), `${provider.key} API guard must precede ${effect}`);
    }

    const retry = readProjectFile(
      `src/app/api/crm/${provider.key}-notifications/[notificationId]/retry/route.ts`,
    );
    const retryGuard = retry.indexOf(`evaluateLaunchScope("${provider.rule}")`);
    assert.ok(retryGuard >= 0);
    for (const effect of ["resolveWorkspaceScopedSession(request", "request.json()", provider.reconcile]) {
      assert.ok(retryGuard < retry.indexOf(effect), `${provider.key} retry guard must precede ${effect}`);
    }

    const cron = readProjectFile(`src/app/api/cron/${provider.key}-alerts/route.ts`);
    const cronGuard = cron.indexOf(`evaluateLaunchScope("${provider.rule}")`);
    assert.ok(cronGuard >= 0);
    for (const effect of ["createCronRun({", provider.scheduled, provider.process]) {
      assert.ok(cronGuard < cron.indexOf(effect), `${provider.key} cron guard must precede ${effect}`);
    }

    const repository = readProjectFile(`src/lib/db/${provider.key}-notification-repositories.ts`);
    const sections = [
      [
        `export async function ${provider.queue}`,
        "export async function queue",
        ["hasDatabaseUrl()", "queryOne<"],
      ],
      [
        `export async function queueScheduledCritical${provider.key === "google" ? "Google" : "Teams"}Alerts`,
        `export async function reconcile${provider.key === "google" ? "Google" : "Teams"}NotificationJob`,
        ["hasDatabaseUrl()", "queryRows<"],
      ],
      [
        `export async function reconcile${provider.key === "google" ? "Google" : "Teams"}NotificationJob`,
        `export async function run${provider.key === "google" ? "Google" : "Teams"}NotificationTargetTestSinkHealthcheck`,
        ["hasDatabaseUrl()", "queryOne<"],
      ],
      [
        `export async function processDue${provider.key === "google" ? "Google" : "Teams"}Notifications`,
        null,
        [
          `listDue${provider.key === "google" ? "Google" : "Teams"}NotificationJobIds`,
          `claim${provider.key === "google" ? "Google" : "Teams"}NotificationJob({`,
          `send${provider.key === "google" ? "Google" : "Teams"}Webhook(job)`,
        ],
      ],
    ];

    for (const [start, end, effects] of sections) {
      const startIndex = repository.indexOf(start);
      const endIndex = end ? repository.indexOf(end, startIndex + start.length) : repository.length;
      const section = repository.slice(startIndex, endIndex > startIndex ? endIndex : repository.length);
      const guard = section.indexOf(`evaluateLaunchScope("${provider.rule}")`);
      assert.ok(guard >= 0, `${start} must enforce ${provider.rule}`);
      for (const effect of effects) {
        const effectIndex = section.indexOf(effect);
        assert.ok(effectIndex >= 0 && guard < effectIndex, `${start} guard must precede ${effect}`);
      }
    }

    for (const [start, effect] of [
      [`async function listDue${provider.key === "google" ? "Google" : "Teams"}NotificationJobIds`, "hasDatabaseUrl()"],
      [`async function prepare${provider.key === "google" ? "Google" : "Teams"}NotificationJobForDelivery`, "queryOne<"],
      [`async function claim${provider.key === "google" ? "Google" : "Teams"}NotificationJob`, "queryOne<"],
      [`async function send${provider.key === "google" ? "Google" : "Teams"}Webhook`, "fetch("],
    ]) {
      const section = repository.slice(repository.indexOf(start));
      const guard = section.indexOf(`evaluateLaunchScope("${provider.rule}")`);
      assert.ok(guard >= 0 && guard < section.indexOf(effect), `${start} must fail before ${effect}`);
    }
  }
});

test("account reset and invitation email are fail-closed across UI, route, repository and Resend", () => {
  const resend = readProjectFile("src/lib/integrations/resend.ts");
  const resetRoute = readProjectFile("src/app/api/auth/password-reset/request/route.ts");
  const resetRepository = readProjectFile("src/lib/auth/password-reset.ts");
  const settingsRoute = readProjectFile("src/app/api/settings/access/users/route.ts");
  const customerRoute = readProjectFile("src/app/api/crm/customer-access/route.ts");
  const settingsRepository = readProjectFile("src/lib/db/settings-access-repositories.ts");
  const customerRepository = readProjectFile("src/lib/db/customer-access-repositories.ts");
  const settingsUi = readProjectFile("src/components/company-profile-settings.tsx");
  const login = readProjectFile("src/app/login/page.tsx");
  const forgot = readProjectFile("src/app/login/forgot-password/page.tsx");

  const resendSend = resend.slice(resend.indexOf("export async function sendNewsletterEmail"));
  const resendGuard = resendSend.indexOf("if (!isEmailDeliveryPurposeLaunchEnabled(input.purpose))");
  assert.ok(resendGuard >= 0 && resendGuard < resendSend.indexOf("getNewsletterProviderStatus()"));
  assert.ok(resendGuard < resendSend.indexOf("fetch(RESEND_API_URL"));
  assert.match(resend, /evaluateLaunchScope\("accountAccessPasswordResetEmail"\)/);
  assert.match(resend, /evaluateLaunchScope\("accountAccessInvitationEmail"\)/);

  const routeGuard = resetRoute.indexOf('evaluateLaunchScope("accountAccessPasswordResetEmail")');
  assert.ok(routeGuard >= 0);
  for (const effect of ["getTrustedAppOrigin()", "request.formData()", "requestPasswordReset({"]) {
    assert.ok(routeGuard < resetRoute.indexOf(effect), `public reset guard must precede ${effect}`);
  }

  const publicReset = resetRepository.slice(resetRepository.indexOf("export async function requestPasswordReset"));
  const publicResetGuard = publicReset.indexOf('evaluateLaunchScope("accountAccessPasswordResetEmail")');
  assert.ok(publicResetGuard >= 0 && publicResetGuard < publicReset.indexOf("hasDatabaseUrl()"));
  assert.ok(publicResetGuard < publicReset.indexOf("reserveAuthRateLimitAttempt({"));
  const membershipLink = resetRepository.slice(
    resetRepository.indexOf("export async function createMembershipPasswordResetLink"),
    resetRepository.indexOf("export async function requestPasswordReset"),
  );
  const membershipGuard = membershipLink.indexOf("evaluateLaunchScope(launchSurface)");
  assert.ok(membershipGuard >= 0 && membershipGuard < membershipLink.indexOf("queryOne<"));

  const settingsPost = settingsRoute.slice(settingsRoute.indexOf("export async function POST"));
  const settingsGuard = settingsPost.indexOf("evaluateLaunchScope(launchSurface)");
  assert.ok(settingsGuard >= 0);
  for (const effect of ["resendWorkspaceInvitation({", "triggerWorkspacePasswordReset({", "inviteSettingsWorkspaceUser({"]) {
    assert.ok(settingsGuard < settingsPost.indexOf(effect), `settings account guard must precede ${effect}`);
  }
  const customerPatch = customerRoute.slice(customerRoute.indexOf("export async function PATCH"));
  const customerGuard = customerPatch.indexOf('evaluateLaunchScope("accountAccessInvitationEmail")');
  assert.ok(customerGuard >= 0 && customerGuard < customerPatch.indexOf("inviteWorkspaceUser({"));

  for (const [source, start, rule, effect] of [
    [settingsRepository, "export async function inviteSettingsWorkspaceUser", "accountAccessInvitationEmail", "inviteWorkspaceUser({"],
    [settingsRepository, "export async function resendWorkspaceInvitation", "accountAccessInvitationEmail", "canPersist()"],
    [settingsRepository, "export async function triggerWorkspacePasswordReset", "accountAccessPasswordResetEmail", "canPersist()"],
    [customerRepository, "export async function inviteWorkspaceUser", "accountAccessInvitationEmail", "canPersist()"],
  ]) {
    const section = source.slice(source.indexOf(start));
    const guard = section.indexOf(`evaluateLaunchScope("${rule}")`);
    assert.ok(guard >= 0 && guard < section.indexOf(effect), `${start} must fail before ${effect}`);
  }

  assert.match(settingsUi, /isLaunchSurfaceEnabled\("accountAccessInvitationEmail"\)/);
  assert.match(settingsUi, /isLaunchSurfaceEnabled\("accountAccessPasswordResetEmail"\)/);
  assert.match(settingsUi, /data-account-access-invitation-launch-scope="off"/);
  assert.match(settingsUi, /data-account-access-password-reset-launch-scope="off"/);
  assert.match(login, /passwordResetEmailLaunchEnabled \? \(/);
  assert.match(forgot, /data-account-access-password-reset-launch-scope="off"/);
  assert.match(forgot, /resetEmailLaunchEnabled \? \(/);
});

test("calendar provider reads fail before token access and surface DB-only status safely", () => {
  const connections = readProjectFile("src/lib/integrations/calendar-connections.ts");
  const meetingRepository = readProjectFile("src/lib/db/meeting-repositories.ts");
  const availabilityRoute = readProjectFile("src/app/api/meetings/availability/route.ts");
  const microsoftRoute = readProjectFile("src/app/api/calendar/microsoft/route.ts");
  const oauthStatus = readProjectFile("src/app/api/meetings/oauth/status/route.ts");

  const readToken = connections.slice(
    connections.indexOf("export async function getCalendarReadAccessToken"),
    connections.indexOf("function getUsableStoredCalendarAccessToken"),
  );
  const tokenGuard = readToken.indexOf('evaluateLaunchScope("calendarProviderRead")');
  assert.ok(tokenGuard >= 0 && tokenGuard < readToken.indexOf("getProviderConnection("));

  const externalBusy = meetingRepository.slice(
    meetingRepository.indexOf("async function listExternalBusyTimes"),
    meetingRepository.indexOf("function getCalendarProviderFromPage"),
  );
  const repositoryGuard = externalBusy.indexOf('evaluateLaunchScope("calendarProviderRead")');
  assert.ok(repositoryGuard >= 0);
  assert.ok(repositoryGuard < externalBusy.indexOf("listGoogleBusyTimes({"));
  assert.ok(repositoryGuard < externalBusy.indexOf("listMicrosoftBusyTimes({"));
  assert.match(externalBusy, /calendar_provider_unavailable/);

  assert.match(availabilityRoute, /if \(availability\.error\)[\s\S]*status: 503/);
  assert.match(availabilityRoute, /"Cache-Control": "private, no-store"/);

  const microsoftGet = microsoftRoute.slice(
    microsoftRoute.indexOf("export async function GET"),
    microsoftRoute.indexOf("export async function POST"),
  );
  assert.match(microsoftGet, /listCalendarSyncEvents/);
  assert.doesNotMatch(microsoftGet, /getCalendarAccessToken|getCalendarReadAccessToken|fetch\(/);
  assert.match(oauthStatus, /getCalendarConnectionStatus/);
  assert.doesNotMatch(oauthStatus, /getCalendarAccessToken|getCalendarReadAccessToken|fetch\(/);
});

test("calendar provider setup is hidden and its client actions stay inert while provider scopes are off", () => {
  const commandCenter = readProjectFile("src/components/calendar-command-center.tsx");

  assert.equal(evaluateLaunchScope("calendarProviderRead").allowed, false);
  assert.equal(evaluateLaunchScope("calendarProviderMutation").allowed, false);
  assert.match(commandCenter, /isLaunchSurfaceEnabled\("calendarProviderRead"\)/);
  assert.match(commandCenter, /isLaunchSurfaceEnabled\("calendarProviderMutation"\)/);
  assert.match(
    commandCenter,
    /calendarProviderReadLaunchEnabled && calendarProviderMutationLaunchEnabled/,
  );

  const enabledPanelStart = commandCenter.indexOf(
    'data-calendar-provider-launch-scope="on"',
  );
  const offPanelStart = commandCenter.indexOf(
    'data-calendar-provider-launch-scope="off"',
  );
  const sharePanelStart = commandCenter.indexOf(
    '<article className="rounded-lg border border-slate-200 bg-white p-5">',
    offPanelStart,
  );
  assert.ok(enabledPanelStart >= 0 && enabledPanelStart < offPanelStart);
  assert.ok(offPanelStart < sharePanelStart);

  const enabledPanel = commandCenter.slice(enabledPanelStart, offPanelStart);
  assert.match(enabledPanel, /id="calendar-default-provider"/);
  assert.match(enabledPanel, /connectCalendarProvider\(option\.id\)/);
  assert.match(enabledPanel, /connectMeetingProvider\(option\.id\)/);
  assert.match(enabledPanel, /disconnectCalendarProvider\(option\.id\)/);

  const offPanel = commandCenter.slice(offPanelStart, sharePanelStart);
  assert.match(offPanel, /calendarProviderLaunchOffMessage/);
  assert.match(offPanel, /role="status"/);
  assert.doesNotMatch(
    offPanel,
    /connectCalendarProvider|connectMeetingProvider|disconnectCalendarProvider|csrfFetch/,
  );

  const liveSyncMarker = commandCenter.indexOf(
    'data-calendar-provider-live-sync="enabled"',
  );
  assert.ok(liveSyncMarker > offPanelStart);
  assert.ok(
    commandCenter.lastIndexOf("{calendarProviderSetupLaunchEnabled ? (", liveSyncMarker) >= 0,
  );
  assert.ok(commandCenter.indexOf(") : null}", liveSyncMarker) > liveSyncMarker);

  for (const [start, end, effects] of [
    [
      "const updateProviderConfig",
      "const connectCalendarProvider",
      ["setCalendarIntegrations("],
    ],
    [
      "const connectCalendarProvider",
      "const connectMeetingProvider",
      ["setCalendarIntegrations(", "navigateToOAuthStart("],
    ],
    [
      "const connectMeetingProvider",
      "const disconnectCalendarProvider",
      ["setCalendarIntegrations(", "navigateToOAuthStart("],
    ],
    [
      "const disconnectCalendarProvider",
      "const liveCalendarMessage",
      ["setLiveCalendarAction(", "csrfFetch("],
    ],
    [
      "const syncLiveTeamsMeeting",
      "if (meetingBuilderOpen)",
      ["setLiveCalendarAction(", "csrfFetch("],
    ],
  ]) {
    const section = commandCenter.slice(
      commandCenter.indexOf(start),
      commandCenter.indexOf(end, commandCenter.indexOf(start)),
    );
    const guard = section.indexOf("if (!calendarProviderSetupLaunchEnabled) return;");
    assert.ok(guard >= 0, `${start} must have a fail-closed client guard`);
    for (const effect of effects) {
      assert.ok(guard < section.indexOf(effect), `${start} must fail before ${effect}`);
    }
  }
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
  assert.equal(evaluateLaunchScope("teamsNotificationDelivery").allowed, false);
  assert.equal(evaluateLaunchScope("googleNotificationDelivery").allowed, false);
  assert.equal(evaluateLaunchScope("accountAccessPasswordResetEmail").allowed, false);
  assert.equal(evaluateLaunchScope("accountAccessInvitationEmail").allowed, false);
  assert.equal(evaluateLaunchScope("calendarProviderRead").allowed, false);
  assert.equal(evaluateLaunchScope("authenticatedBotModelProvider").allowed, false);
  assert.equal(evaluateLaunchScope("externalEmbeddingProvider").allowed, false);
  assert.equal(evaluateLaunchScope("propertyExportQueue").allowed, false);
});

test("external embeddings are launch-off before provider configuration or fetch", () => {
  const embeddings = readProjectFile("src/lib/integrations/embeddings.ts");
  const providerStatus = embeddings.slice(
    embeddings.indexOf("export function getEmbeddingProviderStatus"),
    embeddings.indexOf("function deterministicEmbedding"),
  );
  const embedText = embeddings.slice(embeddings.indexOf("export async function embedText"));
  const statusGuard = providerStatus.indexOf('evaluateLaunchScope("externalEmbeddingProvider")');
  const adapterGuard = embedText.indexOf('evaluateLaunchScope("externalEmbeddingProvider")');

  assert.ok(statusGuard >= 0 && statusGuard < providerStatus.indexOf("resolveEmbeddingProviderConfig()"));
  assert.match(providerStatus, /external_embedding_provider_launch_off/);
  assert.ok(adapterGuard >= 0 && adapterGuard < embedText.indexOf("resolveEmbeddingProviderConfig()"));
  assert.ok(adapterGuard < embedText.indexOf("fetch("));
  assert.match(embedText, /external_embedding_provider_launch_off/);
});

test("authenticated bot model execution is launch-off before request parsing, CRM runtime or provider fetch", () => {
  const route = readProjectFile("src/app/api/bots/chat/route.ts");
  const provider = readProjectFile("src/lib/integrations/model-provider.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const reply = provider.slice(provider.indexOf("export async function generateModelReply"));
  const routeGuard = post.indexOf('evaluateLaunchScope("authenticatedBotModelProvider")');
  const adapterGuard = reply.indexOf('evaluateLaunchScope("authenticatedBotModelProvider")');

  assert.ok(routeGuard >= 0 && routeGuard < post.indexOf("readJson(request)"));
  assert.ok(routeGuard < post.indexOf("runBotChat({"));
  assert.match(post, /authenticated_bot_model_provider_launch_off/);
  assert.ok(adapterGuard >= 0 && adapterGuard < reply.indexOf("resolveProviderConfig()"));
  assert.ok(adapterGuard < reply.indexOf("fetch("));
  assert.match(reply, /authenticated_bot_model_provider_launch_off/);
});

test("consumerless property export queue is launch-off in UI, API and repository before enqueue", () => {
  const route = readProjectFile("src/app/api/crm/properties/route.ts");
  const repository = readProjectFile("src/lib/db/property-department-repositories.ts");
  const propertyDepartment = readProjectFile("src/lib/property-department.ts");
  const commandCenter = readProjectFile("src/components/property-command-center.tsx");
  const preflightBranch = route.slice(
    route.indexOf('if (operation === "run_preflight")'),
    route.indexOf('if (operation !== "create_property")'),
  );
  const recordPreflight = repository.slice(repository.indexOf("export async function recordPropertyPreflightRun"));
  const routeGuard = preflightBranch.indexOf('evaluateLaunchScope("propertyExportQueue")');
  const repositoryGuard = recordPreflight.indexOf('evaluateLaunchScope("propertyExportQueue")');

  assert.ok(routeGuard >= 0 && routeGuard < preflightBranch.indexOf("parseIdempotencyKey(request)"));
  assert.ok(routeGuard < preflightBranch.indexOf("runPropertyChannelPreflight("));
  assert.ok(routeGuard < preflightBranch.indexOf("recordPropertyPreflightRun({"));
  assert.match(preflightBranch, /property_export_queue_launch_off/);
  assert.ok(repositoryGuard >= 0 && repositoryGuard < recordPreflight.indexOf("canPersist()"));
  assert.ok(repositoryGuard < recordPreflight.indexOf("queryOne<IdRow>("));
  assert.match(recordPreflight, /property_export_queue_launch_off/);
  assert.match(propertyDepartment, /isLaunchSurfaceEnabled\("propertyExportQueue"\)/);
  assert.match(propertyDepartment, /enabled: propertyExportQueueLaunchEnabled && canPublish && canAdmin/);
  assert.ok((commandCenter.match(/action=\{actions\.exportChannel\}/g) ?? []).length >= 2);
});

test("runtime media mutations are Preview-testable and unsigned Production is fail-closed at every effect layer", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "preview";
    assert.equal(evaluateLaunchScope("mediaBlobMutation").allowed, true);
    process.env.VERCEL_ENV = "production";
    assert.equal(evaluateLaunchScope("mediaBlobMutation").allowed, false);
    assert.equal(evaluateLaunchScope("mediaBlobMutation").code, "LAUNCH_SCOPE_UNSIGNED");
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }

  const mediaRoute = readProjectFile("src/app/api/media/route.ts");
  const mediaDeleteRoute = readProjectFile("src/app/api/media/[assetId]/route.ts");
  const mediaStore = readProjectFile("src/lib/media-store.ts");
  const picker = readProjectFile("src/components/media-library-picker.tsx");
  const propertyUi = readProjectFile("src/components/property-command-center.tsx");
  const botUi = readProjectFile("src/components/bot-command-center.tsx");
  const botDocuments = readProjectFile("src/app/api/bots/documents/route.ts");
  const post = mediaRoute.slice(mediaRoute.indexOf("export async function POST"));
  const mediaPostGuard = post.indexOf('evaluateLaunchScope("mediaBlobMutation")');
  const mediaDeleteGuard = mediaDeleteRoute.indexOf('evaluateLaunchScope("mediaBlobMutation")');

  assert.ok(mediaPostGuard >= 0 && mediaPostGuard < post.indexOf('request.headers.get("content-type")'));
  assert.ok(mediaPostGuard < post.indexOf("request.formData()"));
  assert.ok(mediaPostGuard < post.indexOf("saveWorkspaceFile({"));
  assert.ok(mediaDeleteGuard >= 0 && mediaDeleteGuard < mediaDeleteRoute.indexOf("context.params"));
  assert.ok(mediaDeleteGuard < mediaDeleteRoute.indexOf("deleteWorkspaceMedia("));
  assert.match(mediaRoute, /mutationsAllowed: mutationScope\.allowed/);
  assert.match(botDocuments, /mutationsAllowed: evaluateLaunchScope\("mediaBlobMutation"\)\.allowed/);

  for (const [start, end, firstEffect] of [
    ["export async function saveWorkspaceFile", "export async function findWorkspaceMediaAsset", "const sizeBytes"],
    ["export async function publishWorkspaceMedia", "export async function revokeWorkspaceMediaShare", "findWorkspaceMediaAsset("],
    ["export async function revokeWorkspaceMediaShare", "export async function extendWorkspaceMediaShare", "hasDatabaseUrl()"],
    ["export async function extendWorkspaceMediaShare", "export async function revokeWorkspaceMediaPublication", "const expiresAt"],
    ["export async function revokeWorkspaceMediaPublication", "export async function getPublicMediaUrl", "hasDatabaseUrl()"],
    ["export async function deleteWorkspaceMedia", "export async function mediaAssetExists", "const asset"],
    ["async function storeMediaFile", "async function deleteStoredFile", "privateBlobToken()"],
    ["async function deleteStoredFile", "function blobTokenForAsset", "asset.storageProvider"],
  ]) {
    const section = mediaStore.slice(mediaStore.indexOf(start), mediaStore.indexOf(end));
    const guard = section.indexOf("assertMediaBlobMutationAllowed()");
    assert.ok(guard >= 0, `${start} lacks the central media mutation guard`);
    assert.ok(guard < section.indexOf(firstEffect), `${start} reaches ${firstEffect} before the guard`);
  }
  const blobPut = mediaStore.slice(mediaStore.indexOf("async function storeMediaFile"), mediaStore.indexOf("async function deleteStoredFile"));
  const blobDelete = mediaStore.slice(mediaStore.indexOf("async function deleteStoredFile"), mediaStore.indexOf("function blobTokenForAsset"));
  assert.ok(blobPut.indexOf("assertMediaBlobMutationAllowed()") < blobPut.indexOf("put("));
  assert.ok(blobDelete.indexOf("assertMediaBlobMutationAllowed()") < blobDelete.indexOf("del("));
  assert.ok(blobDelete.indexOf("assertMediaBlobMutationAllowed()") < blobDelete.indexOf("rm("));

  const pickerUpload = picker.slice(picker.indexOf("async function uploadImage"), picker.indexOf("async function selectForPublicUse"));
  const propertyUpload = propertyUi.slice(propertyUi.indexOf("async function uploadAndAttachFile"), propertyUi.indexOf("return (", propertyUi.indexOf("async function uploadAndAttachFile")));
  const botUpload = botUi.slice(botUi.indexOf("async function uploadDocumentForAction"), botUi.indexOf("return (", botUi.indexOf("async function uploadDocumentForAction")));
  assert.ok(pickerUpload.indexOf("if (!mutationsAllowed)") < pickerUpload.indexOf("new FormData()"));
  assert.ok(pickerUpload.indexOf("if (!mutationsAllowed)") < pickerUpload.indexOf('csrfFetch("/api/media"'));
  assert.ok(propertyUpload.indexOf("!mediaMutationsAllowed") < propertyUpload.indexOf("new FormData()"));
  assert.ok(propertyUpload.indexOf("!mediaMutationsAllowed") < propertyUpload.indexOf('csrfFetch("/api/media"'));
  assert.ok(botUpload.indexOf("if (!documentMutationsAllowed)") < botUpload.indexOf("new FormData()"));
  assert.ok(botUpload.indexOf("if (!documentMutationsAllowed)") < botUpload.indexOf('csrfFetch("/api/media"'));
  assert.match(picker, /disabled=\{!mutationsAllowed \|\| uploading\}/);
  assert.ok((propertyUi.match(/disabled=\{!mediaMutationsAllowed \|\|/g) ?? []).length >= 2);
  assert.match(botUi, /disabled=\{!documentMutationsAllowed \|\| isUploading \|\| isUpdating\}/);
});

test("checked-in launch-scope inventory exactly mirrors all candidate policy rules and decisions", () => {
  const inventory = readProjectFile("docs/audit/2026-08-22/launch-scope-inventory.md");
  const snapshotStart = inventory.indexOf("<!-- BEGIN:launch-scope-policy-snapshot -->");
  const snapshotEnd = inventory.indexOf("<!-- END:launch-scope-policy-snapshot -->");
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, "technical policy snapshot markers are required");
  const snapshot = inventory.slice(snapshotStart, snapshotEnd);
  const documentedRows = [...snapshot.matchAll(/^\| `([a-zA-Z][a-zA-Z0-9]*)` \| `(LAUNCH-ON|LAUNCH-OFF|INTERNAL-ONLY)` \|$/gmu)];
  const documentedPolicy = Object.fromEntries(documentedRows.map((match) => [match[1], match[2]]));
  const candidatePolicy = Object.fromEntries(
    Object.entries(launchScopePolicy).map(([surface, rule]) => [surface, rule.decision]),
  );
  const decisionCounts = Object.values(launchScopePolicy).reduce(
    (counts, rule) => ({ ...counts, [rule.decision]: counts[rule.decision] + 1 }),
    { "INTERNAL-ONLY": 0, "LAUNCH-OFF": 0, "LAUNCH-ON": 0 },
  );

  assert.equal(launchScopePolicyVersion, "2026-08-22.11");
  assert.equal(Object.keys(launchScopePolicy).length, 34);
  assert.deepEqual(decisionCounts, {
    "INTERNAL-ONLY": 5,
    "LAUNCH-OFF": 23,
    "LAUNCH-ON": 6,
  });
  assert.equal(documentedRows.length, Object.keys(launchScopePolicy).length);
  assert.deepEqual(documentedPolicy, candidatePolicy);
  assert.ok(snapshot.includes("Policy-Version: `" + launchScopePolicyVersion + "`"));
  assert.match(snapshot, /Policy-Freigabe: `PENDING_SIGNATURE`/u);
  assert.match(inventory, /Production-Umgebung[\s\S]*`LAUNCH_SCOPE_UNSIGNED`/u);
});

test("every candidate rule obeys its Preview decision and unsigned Production fail-closed contract", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  try {
    assert.equal(Object.isFrozen(launchScopePolicy), true);
    process.env.VERCEL_ENV = "preview";
    for (const [surface, rule] of Object.entries(launchScopePolicy)) {
      assert.equal(Object.isFrozen(rule), true, `${surface} must be immutable`);
      assert.ok(rule.reason.trim().length > 0, `${surface} must document its technical reason`);
      const previewEvaluation = evaluateLaunchScope(surface);
      if (rule.decision === launchScopeDecisions.on) {
        assert.equal(previewEvaluation.allowed, true, `${surface} must follow its Preview LAUNCH-ON decision`);
      } else {
        assert.equal(previewEvaluation.allowed, false, `${surface} must remain closed without an internal actor`);
        assert.equal(
          previewEvaluation.code,
          rule.decision === launchScopeDecisions.off
            ? "LAUNCH_SCOPE_OFF"
            : "LAUNCH_SCOPE_INTERNAL_ONLY",
        );
      }
    }

    process.env.VERCEL_ENV = "production";
    for (const [surface, rule] of Object.entries(launchScopePolicy)) {
      const productionEvaluation = evaluateLaunchScope(surface);
      assert.equal(productionEvaluation.allowed, false, `${surface} must be closed while Production policy is unsigned`);
      assert.equal(
        productionEvaluation.code,
        rule.decision === launchScopeDecisions.off
          ? "LAUNCH_SCOPE_OFF"
          : "LAUNCH_SCOPE_UNSIGNED",
      );
    }
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }
});

test("unsigned LAUNCH-ON and INTERNAL surfaces remain testable in Preview but fail closed in Production", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "preview";
    assert.equal(evaluateLaunchScope("publicFormSubmission").allowed, true);
    assert.equal(
      evaluateLaunchScope("systemDatabaseDiagnostics", {
        productPermissions: ["novalure:internal"],
        productRole: "novalureAdmin",
      }).allowed,
      true,
    );

    process.env.VERCEL_ENV = "production";
    assert.deepEqual(evaluateLaunchScope("publicFormSubmission"), {
      allowed: false,
      code: "LAUNCH_SCOPE_UNSIGNED",
      decision: launchScopeDecisions.on,
      rule: evaluateLaunchScope("publicFormSubmission").rule,
    });
    assert.deepEqual(
      evaluateLaunchScope("systemDatabaseDiagnostics", {
        productPermissions: ["novalure:internal"],
        productRole: "novalureAdmin",
      }),
      {
        allowed: false,
        code: "LAUNCH_SCOPE_UNSIGNED",
        decision: launchScopeDecisions.internalOnly,
        rule: evaluateLaunchScope("systemDatabaseDiagnostics").rule,
      },
    );
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }
});

test("an ambiguous Vercel runtime cannot bypass the unsigned Production boundary", () => {
  const originalVercel = process.env.VERCEL;
  const originalVercelEnv = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL = "1";
    delete process.env.VERCEL_ENV;
    const evaluation = evaluateLaunchScope("publicFormSubmission");
    assert.equal(evaluation.allowed, false);
    assert.equal(evaluation.code, "LAUNCH_SCOPE_RUNTIME_UNSAFE");

    process.env.VERCEL_ENV = "development";
    assert.equal(evaluateLaunchScope("publicFormSubmission").allowed, true);
  } finally {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }
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
  assert.match(qaReset, /resolveQaBatchCapabilityConfig\(\)/);
  assert.match(qaReset, /runtimeConfig\.allowlistedWorkspaceIds/);
});
