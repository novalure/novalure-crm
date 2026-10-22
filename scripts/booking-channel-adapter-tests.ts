import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { getBookingPublication, saveBookingPublication } from "../src/lib/booking/publication";
import { saveBookingRules } from "../src/lib/booking/service";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import type { BookingChannelOptions } from "../src/lib/booking/channels";
import type { BookingProvider, ProviderEvent } from "../src/lib/booking/types";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions } from "../src/lib/crm-machine-auth";
import { verifyMachineBookingAuthority, readSavedBookingGrant } from "../src/lib/booking/channel-bindings";
import { assertBookingChannelSummary, handleMachineBookingRequest, preparedTelephonyBookingIntegration } from "../src/lib/booking/channel-http";
import { verifyStudioChannelSignature } from "../src/lib/booking/studio-channel";
import { prepareFormBookingFields } from "../src/lib/booking/form-field";
import { createFormField, type WebsiteForm } from "../src/lib/form-types";
import { upsertWebsiteForm, getPublicWebsiteForm } from "../src/lib/db/form-repositories";
import { withCrmRead } from "../src/lib/crm-command";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import type { AppSession } from "../src/lib/auth/session";
import type { PublicBookingRecord } from "../src/lib/booking/publication-types";
import { getLegacyBookingReplacement } from "../src/lib/booking/legacy-routing";
import { syncGoogleCalendarEvent, updateGoogleCalendarEvent } from "../src/lib/integrations/google-calendar";
import { syncMicrosoftCalendarEvent, updateMicrosoftCalendarEvent } from "../src/lib/integrations/microsoft-calendar";
import { reschedulePublicMeetingBooking } from "../src/lib/db/meeting-repositories";
import { studioBook, studioBookingAvailability } from "../src/lib/studio-sales-booking";
import { websiteSalesActorId, websiteSalesWorkspaceId } from "../src/lib/website-sales-ingestion";
import type { StudioCalendarPolicy } from "../src/lib/integrations/studio-microsoft-calendar";

const typeId = randomUUID(), publicId = "synthetic-booking-adapter";
const grant = () => ({ booking: { enabled: true, publicId, channels: ["voice"], typeIds: [typeId] } });
test("a knowledge binding, caller number or unapproved channel never creates a booking grant", () => {
  for (const value of [{}, { voiceEnabled: true }, { booking: { ...grant().booking, enabled: false } }, { booking: { ...grant().booking, typeIds: [] } }]) assert.throws(() => readSavedBookingGrant(value, "voice"));
  assert.throws(() => readSavedBookingGrant(grant(), "chat"));
  assert.deepEqual(readSavedBookingGrant(grant(), "voice"), { publicId, typeIds: [typeId] });
  assert.equal(preparedTelephonyBookingIntegration.status, "not_connected");
  assert.equal(preparedTelephonyBookingIntegration.outboundActionsEnabled, false);
});
test("explicit consent is bound to the actual stored date, zone, appointment kind and location", () => {
  const booking: PublicBookingRecord = { id: randomUUID(), state: "held", kind: "onsite", startsAt: "2030-01-05T10:00:00.000Z", endsAt: "2030-01-05T10:30:00.000Z", timeZone: "Europe/Vienna", location: "SYNTHETIC own confirmed address", videoUrl: null, videoStatus: "none", notificationStatus: "not_requested" };
  const summary = { startsAt: booking.startsAt, timeZone: booking.timeZone, kind: booking.kind, location: booking.location };
  assert.doesNotThrow(() => assertBookingChannelSummary({ operation: "confirm", consent: true, summary }, booking));
  for (const patch of [{ consent: false }, { summary: { ...summary, startsAt: "2030-01-06T10:00:00.000Z" } }, { summary: { ...summary, timeZone: "UTC" } }, { summary: { ...summary, location: "another address" } }, { summary: { ...summary, kind: "teams" } }]) assert.throws(() => assertBookingChannelSummary({ operation: "confirm", consent: true, summary, ...patch }, booking), /BOOKING_SUMMARY_CONSENT_REQUIRED/);
});
test("Studio gateway authentication covers exact bytes, contract and fresh timestamp", () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000)), raw = JSON.stringify({ operation: "confirm", consent: true });
  const secret = "SYNTHETIC-studio-booking-signature-value-1234567890";
  const headers = new Headers({ "x-novalure-booking-version": "booking-tools-v1", "x-novalure-timestamp": timestamp,
    "x-novalure-signature": createHmac("sha256", secret).update(`booking-tools-v1.${timestamp}.${raw}`).digest("base64url") });
  assert.equal(verifyStudioChannelSignature(raw, headers, secret, now), true);
  assert.equal(verifyStudioChannelSignature(raw + " ", headers, secret, now), false);
  assert.equal(verifyStudioChannelSignature(raw, headers, secret, now + 301000), false);
  assert.equal(verifyStudioChannelSignature(raw, headers, "", now), false);
});
test("form proof is kept in request memory and never enters the persistent raw payload", () => {
  const field = createFormField({ type: "booking", id: "appointment", crmField: "appointment", label: "Appointment", bookingPublicId: publicId, bookingRequired: true });
  const form = { fields: [field] };
  const data = new FormData(), bookingId = randomUUID(), token = "a".repeat(43);
  data.set("booking_appointment_id", bookingId); data.set("booking_appointment_token", token);
  const proofs = prepareFormBookingFields(form, data);
  assert.equal(proofs[0].token, token); assert.equal(data.get("appointment"), bookingId);
  assert.equal(data.has("booking_appointment_token"), false); assert.equal(data.has("booking_appointment_id"), false);
  assert.equal(JSON.stringify(Object.fromEntries(data)).includes(token), false);
  assert.throws(() => prepareFormBookingFields(form, new FormData()), /FORM_BOOKING_CONFIRMATION_REQUIRED/);
});

test("legacy reschedule rechecks a pending calendar result but persists a known successful result", async () => {
  const workspaceId = randomUUID(), actorId = randomUUID(), pageId = randomUUID(), bookingId = randomUUID(), token = randomUUID();
  const day = new Date(Date.now() + 3 * 86400000), originalAt = new Date(Date.now() + 5 * 86400000).toISOString();
  const selectedDate = day.toISOString().slice(0, 10);
  const names = ["OAUTH_TOKEN_ENCRYPTION_KEY", "MICROSOFT_GRAPH_ACCESS_TOKEN", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_CALENDAR_USER_ID", "MICROSOFT_GRAPH_USER_ID"];
  const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]])), originalFetch = globalThis.fetch;
  const secret = randomBytes(32).toString("hex"), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update("SYNTHETIC-access", "utf8"), cipher.final()]);
  const accessToken = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  for (const name of names) delete process.env[name];
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = secret;
  try {
    for (const provider of ["google", "microsoft"] as const) for (const scenario of ["pending_cutover", "pending_unchanged", "synced_cutover"] as const) {
      let cutover = false, bookingWrites = 0, providerWrites = 0, tokenReads = 0;
      const booking = { id: bookingId, workspaceId, meetingPageId: pageId, slug: "synthetic-pending", pageSlug: "synthetic-pending", title: "SYNTHETIC existing appointment", pageTitle: "SYNTHETIC existing appointment", contactName: "SYNTHETIC visitor", contactEmail: "synthetic@example.invalid", contactNote: "", startsAt: originalAt, endsAt: originalAt, status: "confirmed", calendarProvider: provider, meetingProvider: "phone", workspacePublicKey: "synthetic-workspace", metadata: { publicToken: token, externalCalendarId: "SYNTHETIC-existing-event" }, automation: { confirmationEnabled: false },
        calendarIntegrations: { defaultProvider: "none", availability: { timeZone: "UTC", weeklyHours: Array.from({ length: 7 }, (_, index) => ({ day: index, start: "09:00", end: "17:00" })) } } };
      // Bounded synthetic legacy repository: production privileges and RLS remain unchanged.
      const legacy: TenantTransaction = {
        async query<Row>(sql: string, params: readonly unknown[] = []) {
          if (sql.includes("to_regprocedure")) return [{ installed: true }] as Row[];
          if (sql.includes("booking_workspace_publication_lookup")) return [{ publication: cutover ? { config: { publicId, enabled: true } } : null }] as Row[];
          if (/from meeting_bookings b/.test(sql)) { assert.equal(params[0], bookingId); return [booking] as Row[]; }
          if (/select starts_at[\s\S]+from meeting_bookings/.test(sql)) return [];
          if (/from provider_connections/.test(sql)) {
            tokenReads++; assert.deepEqual(params, [workspaceId, `${provider}-calendar`]);
            if (scenario !== "synced_cutover") { cutover = scenario === "pending_cutover"; return []; }
            return [{ status: "connected", expiresAt: "2099-01-01T00:00:00.000Z", config: { accessToken } }] as Row[];
          }
          if (/update meeting_bookings/.test(sql)) { bookingWrites++; return [{ id: bookingId }] as Row[]; }
          if (/update meeting_notification_jobs/.test(sql)) return [];
          throw new Error("unexpected synthetic legacy repository statement");
        },
        async queryOne() { throw new Error("unexpected synthetic legacy queryOne"); },
        async execute() { throw new Error("unexpected synthetic legacy execute"); },
      };
      globalThis.fetch = async (input, init) => {
        assert.equal(scenario, "synced_cutover"); assert.equal(init?.method, "PATCH");
        assert.match(String(input), provider === "google" ? /^https:\/\/www.googleapis.com\/calendar\/v3\// : /^https:\/\/graph.microsoft.com\/v1.0\//);
        providerWrites++; cutover = true;
        return Response.json({ id: "SYNTHETIC-existing-event" });
      };
      const result = await runWithTenantTransaction({ workspaceId, actorId }, legacy, () => reschedulePublicMeetingBooking({ bookingId, token, selectedDate, slot: "10:00", requestUrl: "https://crm.example.invalid/book/synthetic-pending" }));
      assert.equal(tokenReads, 1, `${provider}/${scenario} reached the calendar context`);
      if (scenario === "pending_cutover") {
        assert.deepEqual(result, { error: "booking_reschedule_requires_organizer", ok: false });
        assert.equal(bookingWrites, 0, `${provider} preserves the original local appointment`);
      } else { assert.equal(result.ok, true, `${provider}/${scenario}`); assert.equal(bookingWrites, 1); }
      assert.equal(providerWrites, scenario === "synced_cutover" ? 1 : 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
  }
});

test("machine booking authority uses actual PostgreSQL principal, actor and independent assistant grant", { timeout: 180000 }, async t => {
  const db = await startDesignCIntegrationDatabase();
  const botId = randomUUID(), principalId = "8b3238e9-efea-459f-ac84-a08e2a6ec59b";
  const now = new Date(), seconds = Math.floor(now.valueOf() / 1000), fake = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
  const machineAuth: CrmMachineAuthOptions = { env: { CRM_MACHINE_AUTH_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" }, now,
    verifier: async () => ({ payload: { aud: CRM_MACHINE_AUDIENCE, environment: CRM_MACHINE_ENVIRONMENT, exp: seconds + 3600, iat: seconds - 5,
      iss: CRM_MACHINE_ISSUER, jti: randomUUID(), nbf: seconds - 5, owner_id: CRM_MACHINE_OWNER_ID, project_id: CRM_MACHINE_PROJECT_ID, sub: CRM_MACHINE_SUBJECT },
      protectedHeader: { alg: "RS256", kid: "synthetic-adapter-test", typ: "JWT" } }) as Awaited<ReturnType<NonNullable<CrmMachineAuthOptions["verifier"]>>> };
  const options = { pool: db.pool as unknown as TenantPool, machineAuth };
  const request = (body: unknown = { operation: "session", typeId }, headers: Record<string, string> = {}) => new Request("https://crm.example.invalid/api/integrations/booking/voice", {
    method: "POST", headers: { authorization: `Bearer ${fake}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    await db.admin.query("insert into bots(id,workspace_id,name,role,config) values($1,$2,'SYNTHETIC booking assistant','advisor','{}')", [botId, CRM_MACHINE_WORKSPACE_ID]);
    await db.admin.query("insert into knowledge_assistant_service_bindings(workspace_id,principal_id,bot_id,channel) values($1,$2,$3,'voice')", [CRM_MACHINE_WORKSPACE_ID, principalId, botId]);
    await t.test("read-only knowledge service mapping alone is denied", async () => { await assert.rejects(verifyMachineBookingAuthority(request(), "voice", options), /BOOKING_CHANNEL_DENIED/); });
    await db.admin.query("update bots set config=$2::jsonb where id=$1", [botId, JSON.stringify(grant())]);
    await t.test("explicit grant resolves server-owned tenant and current allowed assignment", async () => {
      const authority = await verifyMachineBookingAuthority(request(), "voice", options);
      assert.equal(authority.workspaceId, CRM_MACHINE_WORKSPACE_ID); assert.equal(authority.bindingId, principalId); assert.deepEqual(authority.typeIds, [typeId]);
      const altered = await handleMachineBookingRequest(request({ operation: "session", typeId, workspaceId: randomUUID(), callerNumber: "+000000000" }), "voice", options);
      assert.equal(altered.status, 400);
    });
    await t.test("same workload cannot import a cookie or origin as another booking authority", async () => {
      for (const headers of [{ cookie: "novalure_session=SYNTHETIC" }, { origin: "https://foreign.invalid" }] as Record<string, string>[]) await assert.rejects(verifyMachineBookingAuthority(request(undefined, headers), "voice", options), /BOOKING_CHANNEL_DENIED/);
      await assert.rejects(verifyMachineBookingAuthority(request(), "chat", options), /BOOKING_CHANNEL_DENIED/);
    });
    await t.test("revoking the current grant, assistant mapping or principal immediately denies a later tool call", async () => {
      await db.admin.query("update bots set config='{}' where id=$1", [botId]); await assert.rejects(verifyMachineBookingAuthority(request(), "voice", options));
      await db.admin.query("update bots set config=$2::jsonb where id=$1", [botId, JSON.stringify(grant())]);
      await db.admin.query("update knowledge_assistant_service_bindings set enabled=false where principal_id=$1", [principalId]); await assert.rejects(verifyMachineBookingAuthority(request(), "voice", options));
      await db.admin.query("update knowledge_assistant_service_bindings set enabled=true where principal_id=$1", [principalId]);
      await db.admin.query("update crm_service_principals set revoked_at=now() where id=$1", [principalId]); await assert.rejects(verifyMachineBookingAuthority(request(), "voice", options));
    });
    for (const migration of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile(`migrations/${migration}`, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    await t.test("an explicitly published Studio scope keeps both old entry points closed even after disable", async () => {
      const publicationId = randomUUID(), studioPublicId = "synthetic-studio-cutover";
      const config = { publicId: studioPublicId, enabled: true, channels: { chat: true }, assignments: [] };
      await db.admin.query("insert into booking_publications(id,workspace_id,owner_id,public_id,enabled,config,published_at) values($1,$2,$3,$4,true,$5::jsonb,now())", [publicationId, websiteSalesWorkspaceId, websiteSalesActorId, studioPublicId, JSON.stringify(config)]);
      const actor: AppSession = { authenticated: true, source: "database", workspaceId: websiteSalesWorkspaceId, userId: websiteSalesActorId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "synthetic@example.invalid", role: "agent", permissions: getRolePermissions("agent"), productRole: "novalure_operator", productPermissions: getProductRoleCapabilities("novalure_operator") };
      const policy: StudioCalendarPolicy = { approvalId: "SYNTHETIC-CUTOVER", organizerId: "synthetic@example.invalid", calendarId: "SYNTHETIC-calendar", timeZone: "UTC", durationMinutes: 30, intervalMinutes: 30, minNoticeMinutes: 0, bufferMinutes: 15, horizonDays: 2, hours: {} };
      const priorPublicId = process.env.STUDIO_BOOKING_PUBLIC_ID, originalFetch = globalThis.fetch;
      let providerCalls = 0;
      process.env.STUDIO_BOOKING_PUBLIC_ID = studioPublicId;
      globalThis.fetch = async () => { providerCalls++; throw new Error("unexpected synthetic provider request"); };
      try {
        for (const enabled of [true, false]) {
          await db.admin.query("update booking_publications set enabled=$2::boolean,config=jsonb_set(config,'{enabled}',to_jsonb($2::boolean)) where id=$1", [publicationId, enabled]);
          await assert.rejects(withCrmRead(actor, () => studioBookingAvailability(policy, { kind: "teams", visitorTimeZone: "UTC" }), options), /booking_channel_moved/);
          await assert.rejects(withCrmRead(actor, () => studioBook(policy, {}), options), /booking_channel_moved/);
        }
        assert.equal(providerCalls, 0);
        assert.equal((await db.admin.query("select count(*)::int n from booking_reservations where workspace_id=$1", [websiteSalesWorkspaceId])).rows[0].n, 0);
      } finally {
        globalThis.fetch = originalFetch;
        if (priorPublicId === undefined) delete process.env.STUDIO_BOOKING_PUBLIC_ID; else process.env.STUDIO_BOOKING_PUBLIC_ID = priorPublicId;
      }
    });
    const workspaceId = randomUUID(), userId = randomUUID(), publicationId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC booking form','managed_by_novalure','property_developer')", [workspaceId]);
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC form owner','form-adapter@example.invalid','owner','customer_owner','active')", [userId, workspaceId]);
    const actor: AppSession = { authenticated: true, source: "database", workspaceId, userId, workspaceName: "SYNTHETIC", name: "SYNTHETIC", email: "form-adapter@example.invalid", role: "owner", permissions: getRolePermissions("owner"), productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner") };
    const config = { publicId, enabled: true, title: "SYNTHETIC booking form", description: "", appearance: "light", language: "en", allowedOrigins: [], channels: { form: true }, assignments: [] };
    await db.admin.query("insert into booking_publications(id,workspace_id,owner_id,public_id,enabled,config,published_at) values($1,$2,$3,$4,true,$5::jsonb,now())", [publicationId, workspaceId, userId, publicId, JSON.stringify(config)]);
    await t.test("cutover during OAuth refresh prevents the subsequent legacy calendar POST and PATCH", async () => {
      const pageId = randomUUID();
      await db.admin.query("insert into meeting_pages(id,workspace_id,owner_user_id,slug,title) values($1,$2,$3,'synthetic-cutover-race','SYNTHETIC cutover race')", [pageId, workspaceId, userId]);
      const originalFetch = globalThis.fetch;
      const names = ["OAUTH_TOKEN_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_CALENDAR_USER_ID", "MICROSOFT_GRAPH_ACCESS_TOKEN"];
      const beforeEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
      const secret = "SYNTHETIC-isolated-calendar-encryption-1234567890";
      const encrypted = (value: string) => {
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
        const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
      };
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = secret;
      for (const name of names.slice(1, -1)) process.env[name] = "SYNTHETIC-only";
      delete process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
      try {
        for (const provider of ["google", "microsoft"] as const) for (const operation of ["create", "update"] as const) {
          await db.admin.query("update booking_publications set legacy_meeting_page_ids='{}' where id=$1", [publicationId]);
          assert.equal(await getLegacyBookingReplacement(workspaceId, pageId, options), null);
          // A bounded synthetic token-store adapter isolates the legacy transport;
          // no provider-table privilege is added to the forced-RLS runtime role.
          const tokenStore: TenantTransaction = {
            async query<Row>(sql: string, params: readonly unknown[] = []) {
              assert.match(sql, /select[\s\S]+from provider_connections/);
              assert.deepEqual(params, [workspaceId, `${provider}-calendar`]);
              return [{ status: "connected", expiresAt: new Date(0), config: { accessToken: encrypted("SYNTHETIC-expired-access"), refreshToken: encrypted("SYNTHETIC-refresh") } }] as Row[];
            },
            async queryOne() { throw new Error("unexpected synthetic token-store queryOne"); },
            async execute(sql: string, params: readonly unknown[] = []) { assert.match(sql, /update provider_connections/); assert.equal(params[0], workspaceId); assert.equal(params[1], `${provider}-calendar`); },
          };
          let oauthCalls = 0, providerWrites = 0, guardCalls = 0;
          globalThis.fetch = async input => {
            const url = String(input);
            if (url === "https://oauth2.googleapis.com/token" || url.startsWith("https://login.microsoftonline.com/")) {
              oauthCalls++;
              // The publication completes while the old flow awaits this response.
              await db.admin.query("update booking_publications set legacy_meeting_page_ids=array[$2::uuid] where id=$1", [publicationId, pageId]);
              return Response.json({ access_token: "SYNTHETIC-new-access", expires_in: 3600, token_type: "Bearer" });
            }
            providerWrites++;
            throw new Error("unexpected synthetic provider mutation");
          };
          const beforeWrite = async () => {
            guardCalls++;
            if (await getLegacyBookingReplacement(workspaceId, pageId, options)) throw new Error("booking_channel_moved");
          };
          const input = { beforeWrite, workspaceId, startsAt: "2030-01-05T10:00:00.000Z", endsAt: "2030-01-05T10:30:00.000Z", subject: "SYNTHETIC race" };
          const result = await runWithTenantTransaction<{ status: string }>({ workspaceId, actorId: userId }, tokenStore, () => provider === "google"
            ? operation === "create" ? syncGoogleCalendarEvent(input) : updateGoogleCalendarEvent({ ...input, eventId: "SYNTHETIC-owned-event" })
            : operation === "create" ? syncMicrosoftCalendarEvent(input) : updateMicrosoftCalendarEvent({ ...input, eventId: "SYNTHETIC-owned-event" }));
          assert.equal(result.status, "failed", `${provider}/${operation}`);
          assert.equal(oauthCalls, 1, `${provider}/${operation} actual token refresh`);
          assert.equal(guardCalls, 1, `${provider}/${operation} fresh final guard`);
          assert.equal(providerWrites, 0, `${provider}/${operation} zero calendar mutations`);
        }
      } finally {
        globalThis.fetch = originalFetch;
        for (const name of names) if (beforeEnv[name] === undefined) delete process.env[name]; else process.env[name] = beforeEnv[name];
        await db.admin.query("update booking_publications set legacy_meeting_page_ids='{}' where id=$1", [publicationId]);
      }
    });
    const form: WebsiteForm = { id: "new-form", name: "SYNTHETIC booking form", slug: "synthetic-booking-form", status: "aktiv", template: "consultation", fields: [createFormField({ type: "booking", id: "appointment", crmField: "appointment", label: "Appointment", bookingPublicId: publicId, bookingRequired: true })], steps: [{ id: "contact", title: "Contact", description: "" }],
      actions: { createTask: false, followUpEmail: false, internalNotification: false, newsletterList: false, redirectUrl: "", showMeeting: false, thankYouMessage: "SYNTHETIC" }, campaign: "", conversionRate: 0, crmTarget: "lead", doubleOptIn: false, funnelId: "", lastSubmission: "", ownerMode: "user", ownerUserId: userId, pipelineStage: "", progressMode: "none", spamProtection: true, submissions: 0, tags: "", utmCapture: true, variant: "embed", visits: 0 };
    let saved: WebsiteForm;
    await t.test("actual form save and public readback retain the booking field and its approved same-workspace publication", async () => {
      const result = await withCrmRead(actor, () => upsertWebsiteForm({ session: actor, form }), options);
      assert.equal(result.persisted, true, result.reason); assert(result.form); saved = result.form;
      const read = await withCrmRead(actor, tx => getPublicWebsiteForm({ formId: saved.id }, { transaction: tx }), options);
      assert.equal(read?.form.fields[0].type, "booking"); assert.equal(read?.form.fields[0].bookingPublicId, publicId); assert.equal(read?.form.fields[0].bookingRequired, true);
    });
    await t.test("a forged foreign publication is rejected before replacing the saved form configuration", async () => {
      const result = await withCrmRead(actor, () => upsertWebsiteForm({ session: actor, form: { ...saved, fields: [{ ...saved.fields[0], bookingPublicId: "foreign-booking-publication" }] } }), options);
      assert.equal(result.persisted, false); const read = await withCrmRead(actor, tx => getPublicWebsiteForm({ formId: saved.id }, { transaction: tx }), options);
      assert.equal(read?.form.fields[0].bookingPublicId, publicId);
    });
  } finally { await db.stop(); }
});


test("authorized voice HTTP tools complete one consent-bound booking without telephony or network access", { timeout: 180000 }, async t => {
  const previousEnv = { ...process.env }, previousFetch = globalThis.fetch;
  const evidence: Record<string, unknown> = {
    format: "booking-voice-http-contract-v1", syntheticOnly: true,
    realProviderCalls: 0, telephonyCalls: 0, productionAccess: 0,
    oidcMode: "ephemeral local RS256 signature with existing exact workload claims; not live Vercel OIDC",
    checks: [] as string[], status: "RUNNING", cleanup: { complete: false },
  };
  const db = await startDesignCIntegrationDatabase();
  let networkAttempts = 0, creates = 0, updates = 0, deletes = 0, verifiedTokens = 0, requests = 0, invalidSignatureRequests = 0;
  const events = new Map<string, ProviderEvent>();
  const check = async (name: string, run: () => Promise<void>) => {
    let failure: unknown;
    await t.test(name, async () => {
      try { await run(); (evidence.checks as string[]).push(name); }
      catch (error) { failure = error; evidence.status = "FAIL"; throw error; }
    });
    // node:test reports a failed subtest without rejecting t.test(). A failed
    // contract must stop this dependent flow and must never receive a PASS receipt.
    if (failure) throw new Error(`Voice contract check failed: ${name}`, { cause: failure });
  };
  try {
    for (const migration of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query(await readFile(`migrations/${migration}`, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/neondb`,
      CRM_LOCAL_TEST_DATABASE: "1", BOOKING_ENGINE_ENABLED: "1", NOVALURE_APP_ORIGIN: "https://crm.example.invalid",
      NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "BOOKING_PRODUCTION_ENABLED", "BOOKING_TEST_BINDINGS_JSON", "BOOKING_MESSAGES_ENABLED", "BOOKING_REMINDERS_ENABLED"]) delete process.env[name];
    globalThis.fetch = async () => { networkAttempts++; throw new Error("Voice contract forbids every network request"); };
    const now = new Date(), seconds = Math.floor(now.valueOf() / 1000), keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = { alg: "RS256", kid: "synthetic-local-voice-contract", typ: "JWT" };
    const claims = { aud: CRM_MACHINE_AUDIENCE, environment: CRM_MACHINE_ENVIRONMENT, exp: seconds + 3600,
      iat: seconds - 5, iss: CRM_MACHINE_ISSUER, jti: randomUUID(), nbf: seconds - 5, owner_id: CRM_MACHINE_OWNER_ID,
      project_id: CRM_MACHINE_PROJECT_ID, sub: CRM_MACHINE_SUBJECT };
    const signedBytes = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    const signature = sign("RSA-SHA256", Buffer.from(signedBytes), keyPair.privateKey);
    const localToken = `${signedBytes}.${signature.toString("base64url")}`;
    const machineAuth: CrmMachineAuthOptions = { env: { CRM_MACHINE_AUTH_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" }, now,
      verifier: async (token, policy) => {
        const parts = token.split(".");
        assert.equal(parts.length, 3); assert.ok(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), keyPair.publicKey, Buffer.from(parts[2], "base64url")));
        assert.deepEqual(policy?.algorithms, ["RS256"]); assert.equal(policy?.issuer, CRM_MACHINE_ISSUER); assert.equal(policy?.audience, CRM_MACHINE_AUDIENCE);
        verifiedTokens++;
        return { payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")), protectedHeader: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) };
      },
    };
    const organizerId = randomUUID(), connectionId = randomUUID(), botId = randomUUID(), voiceTypeId = randomUUID();
    const principalId = "8b3238e9-efea-459f-ac84-a08e2a6ec59b", calendarId = `synthetic-voice-${organizerId}`;
    const pool = { pool: db.pool as unknown as TenantPool };
    await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC voice organizer',$3,'owner','novalureAdmin','active')", [organizerId, CRM_MACHINE_WORKSPACE_ID, `${organizerId}@example.invalid`]);
    await db.admin.query("insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id,calendars) values($1,$2,$3,'google','connected',$4,$5,$6::jsonb)",
      [connectionId, CRM_MACHINE_WORKSPACE_ID, organizerId, `synthetic-voice-account-${organizerId}`, calendarId, JSON.stringify([{ id: calendarId, name: "SYNTHETIC voice calendar", canWrite: true, canRead: true, teamsSupported: false, meetSupported: false, protectedReadOnly: false }])]);
    const organizer: AppSession = { authenticated: true, source: "database", workspaceId: CRM_MACHINE_WORKSPACE_ID,
      userId: organizerId, workspaceName: "SYNTHETIC voice workspace", name: "SYNTHETIC voice organizer", email: `${organizerId}@example.invalid`,
      role: "owner", permissions: getRolePermissions("owner"), productRole: "novalureAdmin", productPermissions: getProductRoleCapabilities("novalureAdmin") };
    await saveBookingRules(organizer, { rules: { timeZone: "UTC", durationMinutes: 30, preparationMinutes: 0, followupMinutes: 0,
      minNoticeMinutes: 0, cancelNoticeMinutes: 0, rescheduleNoticeMinutes: 0, maxAdvanceDays: 366,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: "09:00", end: "17:00" })) } }, pool);
    await saveBookingSetup(organizer, { scope: "company", kind: "*", section: "communication", value: { enabled: false } }, pool);
    const draft = await getBookingPublication(organizer, pool);
    const publication = { ...draft.publication, enabled: true, title: "SYNTHETIC authorized voice booking", assignments: [{ id: voiceTypeId, organizerId, provider: "google" as const, kind: "phone" as const }],
      channels: { ...draft.publication.channels, voice: true } };
    await saveBookingPublication(organizer, { publication, expectedRevision: draft.revision }, pool);
    const savedGrant = { booking: { enabled: true, publicId: publication.publicId, channels: ["voice"], typeIds: [voiceTypeId] } };
    await db.admin.query("insert into bots(id,workspace_id,name,role,config) values($1,$2,'SYNTHETIC voice HTTP assistant','advisor',$3::jsonb)", [botId, CRM_MACHINE_WORKSPACE_ID, JSON.stringify(savedGrant)]);
    await db.admin.query("insert into knowledge_assistant_service_bindings(workspace_id,principal_id,bot_id,channel) values($1,$2,$3,'voice')", [CRM_MACHINE_WORKSPACE_ID, principalId, botId]);
    const provider: BookingProvider = {
      async listBusy(input) { return [...events.values()].filter(event => !event.cancelled && event.eventId !== input.excludeEventId)
        .map(event => ({ startsAt: event.startsAt, endsAt: event.endsAt, eventId: event.eventId })); },
      async create(input) { creates++; const event: ProviderEvent = { eventId: `synthetic-voice-${input.bookingId}`, etag: '"voice-v1"', startsAt: input.startsAt, endsAt: input.endsAt, onlineMeetingUrl: null, videoStatus: "none", cancelled: false }; events.set(input.bookingId, event); return event; },
      async lookup(input) { return events.get(input.bookingId) ?? null; },
      async update(input) { updates++; const current = events.get(input.bookingId); assert.ok(current); assert.equal(input.etag, current.etag); const event = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, etag: '"voice-v2"' }; events.set(input.bookingId, event); return event; },
      async delete(input) { deletes++; const current = events.get(input.bookingId); assert.ok(current); assert.equal(input.etag, current.etag); events.set(input.bookingId, { ...current, cancelled: true }); },
    };
    const options: BookingChannelOptions & { machineAuth: CrmMachineAuthOptions } = { ...pool, machineAuth,
      providerFactory: async () => provider, connectionResolver: async () => ({ connectionId, calendarId, revision: 1 }) };
    const call = async (body: Record<string, unknown>, token = localToken) => {
      requests++; if (token !== localToken) invalidSignatureRequests++;
      const request = new Request("https://crm.example.invalid/api/integrations/booking/voice", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await handleMachineBookingRequest(request, "voice", options);
      return { status: response.status, body: await response.json() as { token?: string; booking?: PublicBookingRecord; code?: string; slots?: Array<{ startsAt: string; endsAt: string }> } };
    };
    let sessionToken = "", booking: PublicBookingRecord;
    const day = new Date(Date.now() + 3 * 86400000); day.setUTCHours(10, 0, 0, 0);
    const startsAt = day.toISOString(), holdKey = randomUUID();
    await check("normal runtime and all booking channel relations enforce FORCE RLS", async () => {
      const runtime = (await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(runtime, { rolsuper: false, rolbypassrls: false });
      for (const table of ["booking_reservations", "booking_channel_sessions", "booking_channel_operations"]) {
        const row = (await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", [table])).rows[0];
        assert.equal(row.relrowsecurity, true); assert.equal(row.relforcerowsecurity, true);
        assert.equal((await db.pool.query(`select count(*)::int n from ${table}`)).rows[0].n, 0);
      }
    });
    await check("cryptographic workload verification and current saved voice grant issue an opaque scoped session", async () => {
      const altered = Buffer.from(signature); altered[0] ^= 1;
      assert.equal((await call({ operation: "session", typeId: voiceTypeId }, `${signedBytes}.${altered.toString("base64url")}`)).status, 401);
      const issued = await call({ operation: "session", typeId: voiceTypeId, language: "de" });
      assert.equal(issued.status, 200); assert.match(issued.body.token ?? "", /^[A-Za-z0-9_-]{43}$/); sessionToken = issued.body.token!;
      const stored = (await db.admin.query("select channel,binding_id,relation,organizer_id,workspace_id from booking_channel_sessions where token_hash=encode(sha256($1::bytea),'hex')", [sessionToken])).rows[0];
      assert.equal(stored.channel, "voice"); assert.equal(stored.binding_id, principalId); assert.equal(stored.relation.source, "machine"); assert.equal(stored.relation.sourceId, principalId); assert.equal(stored.organizer_id, organizerId); assert.equal(stored.workspace_id, CRM_MACHINE_WORKSPACE_ID);
    });
    await check("voice availability and repeated holds use the shared durable reservation", async () => {
      const availability = await call({ operation: "availability", token: sessionToken, date: startsAt.slice(0, 10) });
      assert.equal(availability.status, 200); assert.ok(availability.body.slots?.some(slot => slot.startsAt === startsAt));
      const body = { operation: "hold", token: sessionToken, startsAt, recipientEmail: "synthetic-voice@example.invalid", recipientName: "SYNTHETIC voice visitor", idempotencyKey: holdKey };
      const held = await call(body); assert.equal(held.status, 200); assert.equal(held.body.booking?.state, "held"); booking = held.body.booking!;
      assert.equal((await call(body)).body.booking?.id, booking.id);
      assert.equal((await db.admin.query("select count(*)::int n from booking_reservations where id=$1", [booking.id])).rows[0].n, 1); assert.equal(creates, 0);
    });
    await check("wrong consent and summary cannot confirm; one correct consent creates once despite replay", async () => {
      const summary = { startsAt: booking.startsAt, timeZone: booking.timeZone, kind: booking.kind, location: booking.location };
      for (const patch of [{ consent: false }, { summary: { ...summary, startsAt: new Date(Date.parse(startsAt) + 3600000).toISOString() } }, { summary: { ...summary, timeZone: "Europe/Vienna" } }, { summary: { ...summary, location: "forged place" } }, { summary: { ...summary, kind: "meet" } }]) {
        const denied = await call({ operation: "confirm", token: sessionToken, bookingId: booking.id, consent: true, summary, ...patch });
        assert.equal(denied.status, 409); assert.equal(denied.body.code, "BOOKING_SUMMARY_CONSENT_REQUIRED");
      }
      assert.equal(creates, 0);
      const body = { operation: "confirm", token: sessionToken, bookingId: booking.id, consent: true, summary };
      const confirmed = await call(body); assert.equal(confirmed.status, 200); assert.equal(confirmed.body.booking?.state, "confirmed"); booking = confirmed.body.booking!;
      assert.equal((await call(body)).body.booking?.state, "confirmed"); assert.equal(creates, 1);
      const canonical = (await db.admin.query("select metadata->>'bookingChannel' channel,metadata->'bookingChannelRelation' relation from meeting_bookings where id=$1", [booking.id])).rows[0];
      assert.equal(canonical.channel, "voice"); assert.equal(canonical.relation.source, "machine"); assert.equal(canonical.relation.sourceId, principalId);
      assert.equal((await db.admin.query("select count(*)::int n from audit_logs where entity_id=$1 and action='booking.channel_consent'", [booking.id])).rows[0].n, 1);
    });
    await check("another session, a foreign scope override and a changed assistant grant cannot access the booking", async () => {
      const other = await call({ operation: "session", typeId: voiceTypeId }); assert.equal(other.status, 200);
      assert.equal((await call({ operation: "status", token: other.body.token, bookingId: booking.id })).status, 404);
      assert.equal((await call({ operation: "status", token: sessionToken, bookingId: booking.id, workspaceId: randomUUID() })).status, 400);
      await db.admin.query("update bots set config=jsonb_set(config,'{booking,typeIds}',$2::jsonb) where id=$1", [botId, JSON.stringify([randomUUID()])]);
      assert.equal((await call({ operation: "status", token: sessionToken, bookingId: booking.id })).status, 403);
      await db.admin.query("update bots set config=$2::jsonb where id=$1", [botId, JSON.stringify(savedGrant)]);
      const own = await call({ operation: "status", token: sessionToken, idempotencyKey: holdKey }); assert.equal(own.status, 200); assert.equal(own.body.booking?.id, booking.id); assert.equal(creates, 1);
    });
    await check("voice reschedule and cancellation each require the exact current summary and replay safely", async () => {
      const target = new Date(Date.parse(booking.startsAt) + 2 * 3600000).toISOString(), rescheduleKey = randomUUID();
      const summary = { startsAt: target, timeZone: booking.timeZone, kind: booking.kind, location: booking.location };
      const moveBody = { operation: "reschedule", token: sessionToken, bookingId: booking.id, startsAt: target, idempotencyKey: rescheduleKey, consent: true, summary };
      assert.equal((await call({ ...moveBody, summary: { ...summary, startsAt: booking.startsAt } })).status, 409);
      assert.equal((await call({ ...moveBody, consent: false })).status, 409); assert.equal(updates, 0);
      const moved = await call(moveBody);
      assert.equal(moved.status, 200); assert.equal(moved.body.booking?.startsAt, target); booking = moved.body.booking!; assert.equal(updates, 1);
      assert.equal((await call(moveBody)).body.booking?.startsAt, target); assert.equal(updates, 1);
      const cancelKey = randomUUID(), body = { operation: "cancel", token: sessionToken, bookingId: booking.id, idempotencyKey: cancelKey, consent: true,
        summary: { startsAt: booking.startsAt, timeZone: booking.timeZone, kind: booking.kind, location: booking.location } };
      assert.equal((await call({ ...body, consent: false })).status, 409);
      assert.equal((await call({ ...body, summary: { ...body.summary, startsAt } })).status, 409); assert.equal(deletes, 0);
      const cancelled = await call(body); assert.equal(cancelled.status, 200); assert.equal(cancelled.body.booking?.state, "cancelled");
      assert.equal((await call(body)).body.booking?.state, "cancelled"); assert.equal(deletes, 1); assert.equal(creates, 1);
      assert.equal((await call({ operation: "status", token: sessionToken, bookingId: booking.id })).body.booking?.state, "cancelled");
    });
    await check("every tool call rechecks the upstream grant and no network, messages or calls occurred", async () => {
      await db.admin.query("update knowledge_assistant_service_bindings set enabled=false where principal_id=$1", [principalId]);
      assert.equal((await call({ operation: "status", token: sessionToken, bookingId: booking.id })).status, 403);
      await db.admin.query("update knowledge_assistant_service_bindings set enabled=true where principal_id=$1", [principalId]);
      assert.equal(verifiedTokens, requests - invalidSignatureRequests); assert.equal(invalidSignatureRequests, 1); assert.equal(networkAttempts, 0);
      assert.equal((await db.admin.query("select count(*)::int n from booking_message_jobs where workspace_id=$1", [CRM_MACHINE_WORKSPACE_ID])).rows[0].n, 0);
      assert.equal(preparedTelephonyBookingIntegration.status, "not_connected"); assert.equal(preparedTelephonyBookingIntegration.outboundActionsEnabled, false);
    });
    evidence.status = "PASS_ISOLATED_VOICE_HTTP_CONTRACT";
    evidence.providerPortOperations = { creates, updates, deletes, liveEvents: [...events.values()].filter(event => !event.cancelled).length };
    evidence.verifiedLocalSignatures = verifiedTokens; evidence.toolRequests = requests; evidence.invalidSignatureRequests = invalidSignatureRequests; evidence.networkAttempts = networkAttempts;
  } catch (error) {
    evidence.status = "FAIL"; evidence.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    globalThis.fetch = previousFetch;
    const cleanupFailures: string[] = [];
    let clusterStopped = false, disposableDirectoryRemoved = false;
    try {
      try { await closeLocalTestPool(); } catch { cleanupFailures.push("local-pool-close"); }
      try { await db.stop(); clusterStopped = true; } catch { cleanupFailures.push("cluster-stop"); }
      // The complete database is this test's disposable loopback cluster. Audit
      // records are never deleted or rewritten through application tables.
      if (clusterStopped) {
        try { await rm(db.directory, { recursive: true, force: true }); disposableDirectoryRemoved = true; }
        catch { cleanupFailures.push("disposable-directory-remove"); }
      }
    } finally { process.env = previousEnv; events.clear(); }
    evidence.cleanup = { complete: cleanupFailures.length === 0 && clusterStopped && disposableDirectoryRemoved,
      clusterStopped, disposableDirectoryRemoved, simulatedEventsRemoved: true, failures: cleanupFailures };
    if (cleanupFailures.length) evidence.status = "FAIL_CLEANUP";
    await mkdir(".npm-cache/qa/booking3", { recursive: true });
    await writeFile(".npm-cache/qa/booking3/voice-http-contract.json", JSON.stringify(evidence, null, 2));
    assert.deepEqual(cleanupFailures, [], "The isolated voice test must clean up completely");
  }
});
