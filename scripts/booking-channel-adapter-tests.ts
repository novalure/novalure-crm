import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";
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
  const secret = "SYNTHETIC-legacy-pending-regression-1234567890", iv = randomBytes(12);
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
