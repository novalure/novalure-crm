import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function loadLifecycleHelpers() {
  const path = "src/lib/meetings/booking-lifecycle.ts";
  const output = ts.transpileModule(await source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const cjsModule = { exports: {} };
  const lifecycleRequire = (specifier) => specifier === "@/lib/launch-scope"
    ? { isLaunchSurfaceEnabled: () => false }
    : require(specifier);
  vm.runInNewContext(
    output,
    { Date, Intl, Object, Set, exports: cjsModule.exports, module: cjsModule, require: lifecycleRequire },
    { filename: path },
  );
  return cjsModule.exports;
}

test("DST conversion rejects missing wall-clock times and resolves two time zones deterministically", async () => {
  const { zonedDateTimeToUtc } = await loadLifecycleHelpers();

  assert.equal(
    zonedDateTimeToUtc({ date: "2026-03-29", time: "02:30", timeZone: "Europe/Vienna" }),
    null,
  );
  assert.equal(
    zonedDateTimeToUtc({ date: "2026-01-15", time: "09:00", timeZone: "Europe/Vienna" }).toISOString(),
    "2026-01-15T08:00:00.000Z",
  );
  assert.equal(
    zonedDateTimeToUtc({ date: "2026-01-15", time: "09:00", timeZone: "America/New_York" }).toISOString(),
    "2026-01-15T14:00:00.000Z",
  );
  assert.equal(
    zonedDateTimeToUtc({ date: "2026-10-25", time: "02:30", timeZone: "Europe/Vienna" }).toISOString(),
    "2026-10-25T00:30:00.000Z",
  );
});

test("booking persistence serializes overlapping slots and carries one correlation id", async () => {
  const repository = await source("src/lib/db/meeting-repositories.ts");

  assert.match(repository, /pg_advisory_xact_lock\(hashtextextended\(\$2::text, 0\)\)/);
  assert.match(repository, /existing\.starts_at < \$9::timestamptz \+ make_interval/);
  assert.match(repository, /existing\.ends_at > \$8::timestamptz - make_interval/);
  assert.match(repository, /on conflict do nothing/);
  assert.match(repository, /correlationId,\s*publicToken,\s*requestUrl/);
  assert.match(repository, /correlationId,\s*requestUrl: input\.requestUrl,\s*rollbackOnFailure: true/);
});

test("confirm is retry-safe for CRM, provider and notification records", async () => {
  const [repository, google, microsoft] = await Promise.all([
    source("src/lib/db/meeting-repositories.ts"),
    source("src/lib/integrations/google-calendar.ts"),
    source("src/lib/integrations/microsoft-calendar.ts"),
  ]);

  assert.match(repository, /existing\.metadata->>'bookingId' = \$12/);
  assert.match(repository, /booking\.status === "confirmed"/);
  assert.match(repository, /meeting-notification:\$\{correlationId\}:confirmation:confirmed/);
  assert.match(repository, /recoveryState: rollbackSucceeded \? "rolled_back" : "provider_cleanup_required"/);
  assert.match(google, /id: eventKey/);
  assert.match(google, /response\.status === 409 && eventKey/);
  assert.match(google, /novalureCorrelationId: input\.correlationId/);
  assert.match(microsoft, /transactionId: input\.correlationId/);
  assert.match(microsoft, /const timeZone = "UTC"/);
});

test("reschedule and cancel use a claimed state transition and idempotent provider deletion", async () => {
  const [repository, google, microsoft, bookingPage] = await Promise.all([
    source("src/lib/db/meeting-repositories.ts"),
    source("src/lib/integrations/google-calendar.ts"),
    source("src/lib/integrations/microsoft-calendar.ts"),
    source("src/app/book/public-booking-page.tsx"),
  ]);

  assert.match(repository, /claimPublicMeetingBookingAction/);
  assert.match(repository, /coalesce\(metadata#>>'\{lifecycleAction,status\}', ''\) <> 'processing'/);
  assert.match(repository, /metadata#>>'\{lifecycleAction,correlationId\}' = \$7/);
  assert.match(repository, /const rollback = await syncExternalCalendarForPublicAction/);
  assert.match(repository, /meeting-notification:\$\{correlationId\}:confirmation:cancelled/);
  assert.match(repository, /meeting-notification:\$\{correlationId\}:confirmation:rescheduled/);
  assert.match(google, /response\.status !== 404 && response\.status !== 410/);
  assert.match(microsoft, /response\.status !== 404/);
  assert.equal((bookingPage.match(/name="action_id"/g) ?? []).length, 2);
});

test("public create, cancel and reschedule are fail-closed until a durable reconciliation saga exists", async () => {
  const [lifecycle, launchScope, repository, createRoute, cancelRoute, rescheduleRoute, bookingPage, copy] = await Promise.all([
    source("src/lib/meetings/booking-lifecycle.ts"),
    source("src/lib/launch-scope.ts"),
    source("src/lib/db/meeting-repositories.ts"),
    source("src/app/api/meetings/bookings/route.ts"),
    source("src/app/api/meetings/bookings/[bookingId]/cancel/route.ts"),
    source("src/app/api/meetings/bookings/[bookingId]/reschedule/route.ts"),
    source("src/app/book/public-booking-page.tsx"),
    source("src/lib/i18n.ts"),
  ]);

  assert.match(lifecycle, /bookingCreationLaunchEnabled = isLaunchSurfaceEnabled\("publicBookingCreation"\)/);
  assert.match(lifecycle, /publicBookingCreationLaunchEnabled = bookingCreationLaunchEnabled/);
  assert.match(lifecycle, /BOOKING_CREATION_LAUNCH_OFF/);
  assert.match(lifecycle, /publicBookingLifecycleMutationsLaunchEnabled = isLaunchSurfaceEnabled\("publicBookingLifecycle"\)/);
  assert.match(lifecycle, /PUBLIC_BOOKING_LIFECYCLE_LAUNCH_OFF/);
  assert.match(launchScope, /publicBookingCreation:[\s\S]*decision: launchScopeDecisions\.off/);
  assert.match(launchScope, /publicBookingLifecycle:[\s\S]*decision: launchScopeDecisions\.off/);
  const createGuard = createRoute.indexOf("if (!publicBookingCreationLaunchEnabled)");
  assert.ok(createGuard >= 0);
  assert.ok(createGuard < createRoute.indexOf("readBoundedPublicSubmissionFormData(request"));
  assert.ok(createGuard < createRoute.indexOf("getPublicMeetingPageSettings({"));
  assert.ok(createGuard < createRoute.indexOf("createMeetingBookingWithNotifications({"));
  assert.match(createRoute.slice(createGuard, createRoute.indexOf("let correlationId", createGuard)), /status: 503/);
  assert.match(createRoute.slice(createGuard, createRoute.indexOf("let correlationId", createGuard)), /"cache-control": "private, no-store"/);
  const repositoryCreate = repository.slice(
    repository.indexOf("export async function createMeetingBookingWithNotifications"),
    repository.indexOf("export async function listMeetingBookingOverview"),
  );
  const repositoryGuard = repositoryCreate.indexOf("if (!bookingCreationLaunchEnabled)");
  assert.ok(repositoryGuard >= 0);
  assert.ok(repositoryGuard < repositoryCreate.indexOf("hasDatabaseUrl()"));
  assert.ok(repositoryGuard < repositoryCreate.indexOf("resolveMeetingPageForBooking(input)"));
  assert.ok(repositoryGuard < repositoryCreate.indexOf("getMeetingAvailabilityForPage(page"));
  assert.ok(repositoryGuard < repositoryCreate.indexOf("insert into meeting_bookings"));
  assert.ok(repositoryGuard < repositoryCreate.indexOf("confirmMeetingBooking({"));
  for (const route of [cancelRoute, rescheduleRoute]) {
    const guard = route.indexOf("if (!publicBookingLifecycleMutationsLaunchEnabled)");
    const bodyRead = route.indexOf("await request.formData()");
    const repositoryCall = route.indexOf("PublicMeetingBooking({");
    assert.ok(guard >= 0 && guard < bodyRead && guard < repositoryCall);
    assert.match(route, /status: 503/);
    assert.match(route, /"cache-control": "private, no-store"/);
  }
  assert.equal(
    (repository.match(/if \(!publicBookingLifecycleMutationsLaunchEnabled\)/g) ?? []).length,
    2,
  );
  assert.match(bookingPage, /data-booking-lifecycle-launch-scope=\{lifecycleMutationLaunchOff \? "off" : undefined\}/);
  assert.match(bookingPage, /data-booking-creation-launch-scope=\{creationLaunchOff \? "off" : undefined\}/);
  assert.match(bookingPage, /publicBookingActionLaunchOff\s*\? null\s*: cancelMode/);
  assert.match(bookingPage, /const availability = publicBookingActionLaunchOff\s*\? null/);
  assert.match(bookingPage, /copy\.status\.errors\.public_action_launch_off/);
  assert.match(bookingPage, /copy\.status\.errors\.public_booking_creation_launch_off/);
  assert.match(copy, /New online bookings are temporarily unavailable/);
  assert.match(copy, /Neue Online-Buchungen sind vorübergehend nicht verfügbar/);
  assert.match(copy, /Cancellation and rescheduling are temporarily unavailable/);
  assert.match(copy, /Absage und Verschiebung sind vorübergehend nicht verfügbar/);
});

test("public routes fail closed and expose localized recovery codes with correlation headers", async () => {
  const [page, bookingRoute, confirmRoute, cancelRoute, rescheduleRoute, copy] = await Promise.all([
    source("src/app/book/public-booking-page.tsx"),
    source("src/app/api/meetings/bookings/route.ts"),
    source("src/app/api/meetings/bookings/[bookingId]/confirm/route.ts"),
    source("src/app/api/meetings/bookings/[bookingId]/cancel/route.ts"),
    source("src/app/api/meetings/bookings/[bookingId]/reschedule/route.ts"),
    source("src/lib/i18n.ts"),
  ]);

  assert.match(page, /if \(!savedPage\?\.id \|\| !savedPage\.workspaceId\) notFound\(\)/);
  assert.match(page, /if \(!publicBookingActionLaunchOff && !availability\) notFound\(\)/);
  assert.match(bookingRoute, /`booking-\$\{hashes\.idempotencyHash\}`/);
  assert.match(bookingRoute, /headers\.set\("x-correlation-id", correlationId\)/);
  assert.match(confirmRoute, /headers\.set\("x-correlation-id"/);
  assert.match(cancelRoute, /lang: getFormValue\(formData, "lang"\)/);
  assert.match(rescheduleRoute, /lang: getFormValue\(formData, "lang"\)/);
  assert.match(copy, /calendar_provider_unavailable:/);
  assert.match(copy, /action_recovery_required:/);
});
