import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import {
  CRM_MACHINE_AUDIENCE, CRM_MACHINE_ENVIRONMENT, CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID, CRM_MACHINE_SUBJECT, CRM_MACHINE_WORKSPACE_ID,
} from "../src/lib/crm-machine-auth";
import { STUDIO_VOICE_AUDIENCE, type StudioVoiceMachineAuthOptions } from "../src/lib/studio-voice-machine-auth";
import {
  handleStudioVoiceBookingRequest, handleVoiceBookingRequest, verifyStudioVoiceBookingAuthority,
  type StudioVoiceBookingOptions,
} from "../src/lib/booking/studio-voice-authority";
import { dispatchTrustedBookingTool, handleMachineBookingRequest } from "../src/lib/booking/channel-http";
import { dispatchBookingChannelAction, startBookingChannelSession } from "../src/lib/booking/channels";
import { getBookingPublication, saveBookingPublication } from "../src/lib/booking/publication";
import { saveBookingRules } from "../src/lib/booking/service";
import { saveBookingSetup } from "../src/lib/booking/configuration";
import type { PublicBookingRecord } from "../src/lib/booking/publication-types";
import type { BookingProvider, ProviderEvent } from "../src/lib/booking/types";
import { startDesignCIntegrationDatabase } from "./lib/design-c-integration-fixture.mjs";

const origin = "https://crm.voice.fixture";
const runtime = { STUDIO_VOICE_AUTH_ENABLED: "1", CRM_MACHINE_AUTH_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
type Verifier = NonNullable<StudioVoiceMachineAuthOptions["verifier"]>;
type VerificationResult = Awaited<ReturnType<Verifier>>;

function claims(aud: unknown) {
  const at = Math.floor(Date.now() / 1000);
  return { aud, environment: CRM_MACHINE_ENVIRONMENT, exp: at + 300, iat: at - 5, iss: CRM_MACHINE_ISSUER,
    jti: randomUUID(), nbf: at - 5, owner_id: CRM_MACHINE_OWNER_ID, project_id: CRM_MACHINE_PROJECT_ID, sub: CRM_MACHINE_SUBJECT };
}
function localBearer(aud?: unknown) {
  return [JSON.stringify({ alg: "RS256", typ: "JWT", kid: "offline-authority-fixture" }), JSON.stringify(claims(arguments.length ? aud : STUDIO_VOICE_AUDIENCE))]
    .map(value => Buffer.from(value).toString("base64url")).join(".") + ".bG9jYWwtb25seS1zaWduYXR1cmUtc3R1Yg";
}
// The cryptographic verifier is tested separately with real offline RSA keys.
// This fixture exercises the actual PostgreSQL authority and booking engine.
const machineAuth: StudioVoiceMachineAuthOptions = { env: runtime, verifier: async raw => ({
  payload: JSON.parse(Buffer.from(raw.split(".")[1]!, "base64url").toString("utf8")),
  protectedHeader: { alg: "RS256", typ: "JWT", kid: "offline-authority-fixture" },
}) as VerificationResult };
function request(body: Record<string, unknown>, headers: Record<string, string> = {}, bearer = localBearer(), url = `${origin}/api/integrations/booking/voice`) {
  return new Request(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function gate() {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, async wait() { entered(); await waiting; } };
}

test("voice audience routing rejects unknown selectors and never falls back after failed Studio verification", async () => {
  let verifications = 0;
  const options: StudioVoiceBookingOptions = { machineAuth: { env: runtime, verifier: async (_raw, expected) => {
    verifications++;
    assert.equal(expected!.audience, STUDIO_VOICE_AUDIENCE);
    throw new Error("OFFLINE_SIGNATURE_REJECTED");
  } } };
  for (const aud of [undefined, "urn:foreign", [STUDIO_VOICE_AUDIENCE, CRM_MACHINE_AUDIENCE], {}, null]) {
    const response = await handleVoiceBookingRequest(request({ operation: "session", typeId: randomUUID() }, {}, localBearer(aud)), options);
    assert.equal(response.status, 403);
  }
  assert.equal(verifications, 0, "an unrecognized untrusted selector never chooses a verifier");
  const rejected = await handleVoiceBookingRequest(request({ operation: "session", typeId: randomUUID() }), options);
  assert.equal(rejected.status, 401);
  assert.equal(verifications, 1, "a failed Studio signature must not try generic CRM authentication");
  assert.equal(rejected.headers.get("cache-control"), "private, no-store");
});

test("Studio voice uses independent forced-RLS authority and the existing durable booking engine", { timeout: 240_000 }, async t => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const db = await startDesignCIntegrationDatabase();
  const workspaceId = CRM_MACHINE_WORKSPACE_ID;
  const id = { actor: randomUUID(), alternateActor: randomUUID(), organizer: randomUUID(), bot: randomUUID(), principal: randomUUID(), grant: randomUUID(),
    connection: randomUUID(), assignment: randomUUID(), activation: randomUUID(), activationRow: randomUUID() };
  const calendarId = "offline-studio-calendar", accountId = "offline-studio-account";
  const ddlRole = "studio_voice_ddl";
  const pool = { pool: db.pool as unknown as TenantPool };
  let creates = 0, updates = 0, deletes = 0, networkRequests = 0, pauseBusy: (() => Promise<void>) | undefined;
  const events = new Map<string, ProviderEvent>();
  const provider: BookingProvider = {
    async listBusy() { await pauseBusy?.(); return []; },
    async lookup(input) { return events.get(input.bookingId) ?? null; },
    async create(input) {
      creates++;
      const event: ProviderEvent = { eventId: `offline-${input.bookingId}`, etag: '"offline-one"', startsAt: input.startsAt,
        endsAt: input.endsAt, onlineMeetingUrl: "https://meeting.voice.fixture/offline", videoStatus: "ready", cancelled: false };
      events.set(input.bookingId, event); return event;
    },
    async update(input) { updates++; const event = { ...events.get(input.bookingId)!, startsAt: input.startsAt, endsAt: input.endsAt }; events.set(input.bookingId, event); return event; },
    async delete(input) { deletes++; events.set(input.bookingId, { ...events.get(input.bookingId)!, cancelled: true }); },
  };
  const options: StudioVoiceBookingOptions = { ...pool, machineAuth, providerFactory: async () => provider,
    connectionResolver: async () => ({ connectionId: id.connection, calendarId, revision: 1 }) };
  const counts = async () => (await db.admin.query(`select
    (select count(*)::int from booking_channel_sessions) sessions,
    (select count(*)::int from booking_channel_rate_buckets) buckets,
    (select count(*)::int from booking_channel_operations) channel_operations,
    (select count(*)::int from booking_reservations) reservations`)).rows[0];
  const call = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await handleStudioVoiceBookingRequest(request(body, headers), options);
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const actorSession = (userId: string): AppSession => ({ authenticated: true, source: "database", workspaceId, userId,
    workspaceName: "Offline local Studio fixture", name: "Offline organizer", email: "organizer@studio.fixture",
    role: "owner", productRole: "novalureAdmin", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("novalureAdmin") });
  try {
    // No connection string from the environment is read: this fixture creates
    // its own disposable loopback cluster. All records below are local stand-ins.
    Object.assign(process.env, { NODE_ENV: "test", BOOKING_ENGINE_ENABLED: "1", NOVALURE_APP_ORIGIN: origin,
      NOVALURE_AUTH_RATE_LIMIT_SECRET: "offline-studio-rate-limit-value-123456789012345" });
    globalThis.fetch = async () => { networkRequests++; throw new Error("OFFLINE_TEST_FORBIDS_EXTERNAL_REQUESTS"); };
    for (const name of ["VERCEL_ENV", "VERCEL", "BOOKING_PRODUCTION_ENABLED"]) delete process.env[name];
    for (const name of ["108_universal_booking.sql", "109_booking_setup_communications.sql", "111_booking_public_channels.sql", "112_booking_production_activation.sql"]) {
      const client = await db.admin.connect();
      try { await client.query("begin"); await client.query("set local role neondb_owner"); await client.query(await readFile(`migrations/${name}`, "utf8")); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    const installer = await db.admin.connect();
    try {
      await installer.query("begin");
      await installer.query(`create role ${ddlRole} nologin nosuperuser nobypassrls inherit`);
      // Role membership grants DDL ownership rights; BYPASSRLS is a non-inherited
      // role attribute. The new SECURITY DEFINER routines run as this NOBYPASS role.
      await installer.query(`grant neondb_owner to ${ddlRole}`);
      await installer.query(`grant usage,create on schema public to ${ddlRole}`);
      await installer.query("commit");
      await installer.query(`set role ${ddlRole}`);
      const identity = (await installer.query("select current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(identity, { role: ddlRole, rolsuper: false, rolbypassrls: false });
      await installer.query(await readFile("migrations/drafts/studio-voice-booking-authority.sql", "utf8"));
    } catch (error) { await installer.query("rollback"); throw error; } finally { await installer.query("reset role"); installer.release(); }

    await t.test("the draft installs empty under a NOBYPASS owner and grants no runtime table authority", async () => {
      assert.deepEqual((await db.admin.query("select (select count(*)::int from studio_voice_principals) principals,(select count(*)::int from studio_voice_booking_grants) grants")).rows[0], { principals: 0, grants: 0 });
      const tables = (await db.admin.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname,r.rolsuper,r.rolbypassrls
        from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
        where n.nspname='public' and c.relname in ('studio_voice_principals','studio_voice_booking_grants') order by c.relname`)).rows;
      assert.equal(tables.length, 2);
      for (const table of tables) assert.deepEqual({ rls: table.relrowsecurity, forced: table.relforcerowsecurity, owner: table.rolname, superuser: table.rolsuper, bypass: table.rolbypassrls },
        { rls: true, forced: true, owner: ddlRole, superuser: false, bypass: false });
      const auth = (await db.admin.query(`select r.rolname,r.rolsuper,r.rolbypassrls,p.prosecdef from pg_proc p join pg_roles r on r.oid=p.proowner
        where p.oid='public.studio_voice_authenticate(text,text,text,text,text,text)'::regprocedure`)).rows[0];
      assert.deepEqual(auth, { rolname: ddlRole, rolsuper: false, rolbypassrls: false, prosecdef: true });
      const runtimeIdentity = (await db.pool.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(runtimeIdentity, { rolsuper: false, rolbypassrls: false });
      for (const table of ["studio_voice_principals", "studio_voice_booking_grants"]) {
        await assert.rejects(db.pool.query(`select * from ${table}`), /permission denied/);
        await assert.rejects(db.pool.query(`update ${table} set enabled=true`), /permission denied/);
        await assert.rejects(db.pool.query(`insert into ${table}(workspace_id) values($1)`, [workspaceId]), /permission denied/);
      }
      const before = await counts();
      const result = await call({ operation: "session", typeId: id.assignment });
      assert.equal(result.response.status, 403);
      assert.deepEqual(await counts(), before);
    });

    await db.admin.query("update workspaces set name='Offline Studio fixture',is_qa=false where id=$1", [workspaceId]);
    for (const [userId, label, email, role, productRole] of [[id.actor, "Offline service actor", "service@studio.fixture", "agent", "novalure_operator"], [id.alternateActor, "Offline alternative service actor", "alternative@studio.fixture", "agent", "novalure_operator"], [id.organizer, "Offline organizer", "organizer@studio.fixture", "owner", "novalureAdmin"]]) {
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,'active')", [userId, workspaceId, label, email, role, productRole]);
      await db.admin.query("update auth_identities set credential_state='active' where id=(select auth_identity_id from workspace_users where id=$1)", [userId]);
    }
    await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true) on conflict(workspace_id,module_key) do update set enabled=true", [workspaceId]);
    await db.admin.query("insert into bots(id,workspace_id,name,role,status,config) values($1,$2,'Offline Studio bot','advisor','Aktiv','{}')", [id.bot, workspaceId]);
    await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,account_label,encrypted_tokens,scopes,write_calendar_id,calendars)
      values($1,$2,$3,'microsoft','connected',$4,'Offline account','b1.offline-test-only',array['Calendars.ReadWrite'],$5,$6::jsonb)`,
      [id.connection, workspaceId, id.organizer, accountId, calendarId, JSON.stringify([{ id: calendarId, name: "Offline calendar", canRead: true, canWrite: true, protectedReadOnly: false, teamsSupported: true, meetSupported: false }])]);
    const organizer = actorSession(id.organizer);
    await saveBookingRules(organizer, { rules: { timeZone: "UTC", minNoticeMinutes: 0, preparationMinutes: 0, followupMinutes: 0,
      maxAdvanceDays: 366, workingHours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: "09:00", end: "17:00" })) } }, pool);
    await saveBookingSetup(organizer, { scope: "company", kind: "*", section: "communication", value: { enabled: false } }, pool);
    const draft = await getBookingPublication(organizer, pool);
    const publication = { ...draft.publication, enabled: true, channels: { ...draft.publication.channels, voice: true },
      assignments: [{ id: id.assignment, kind: "teams" as const, provider: "microsoft" as const, organizerId: id.organizer }] };
    await saveBookingPublication(organizer, { publication, expectedRevision: 0 }, pool);
    await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: { enabled: true, publicId: publication.publicId, channels: ["voice"], typeIds: [id.assignment] } })]);
    const stored = (await db.admin.query("select id,revision from booking_publications where workspace_id=$1", [workspaceId])).rows[0];
    await db.admin.query(`insert into booking_production_activations(id,activation_id,workspace_id,user_id,provider,connection_id,account_id,calendar_id,production_origin,capabilities,activated_at,review_reference)
      values($1,$2,$3,$4,'microsoft',$5,$6,$7,$8,array['booking'],now(),'LOCAL DISPOSABLE TEST ONLY')`,
      [id.activationRow, id.activation, workspaceId, id.organizer, id.connection, accountId, calendarId, origin]);
    await db.admin.query(`insert into studio_voice_principals(id,workspace_id,actor_user_id,identity_id,issuer,audience,project_id,owner_id,subject,environment,valid_from,valid_until,authority_reference)
      values($1,$2,$3,'NOVALURE_STUDIO_VOICE_BOOKING',$4,$5,$6,$7,$8,'production',now()-interval '1 minute',now()+interval '1 hour','LOCAL DISPOSABLE TEST ONLY')`,
      [id.principal, workspaceId, id.actor, CRM_MACHINE_ISSUER, STUDIO_VOICE_AUDIENCE, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_OWNER_ID, CRM_MACHINE_SUBJECT]);
    await db.admin.query(`insert into studio_voice_booking_grants(id,workspace_id,principal_id,bot_id,publication_id,publication_revision,assignment_id,organizer_id,connection_id,connection_revision,account_id,calendar_id,production_activation_id,production_origin,valid_from,valid_until,authority_reference)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,now()-interval '1 minute',now()+interval '1 hour','LOCAL DISPOSABLE TEST ONLY')`,
      [id.grant, workspaceId, id.principal, id.bot, stored.id, stored.revision, id.assignment, id.organizer, id.connection, accountId, calendarId, id.activation, origin]);
    assert.equal((await db.admin.query("select public.booking_production_connection_eligible($1,$2,$3,'microsoft',$4,$5) as eligible", [workspaceId, id.organizer, id.connection, accountId, calendarId])).rows[0].eligible,
      true, "the unchanged production resource predicate must accept these disposable local stand-ins before authority tests are meaningful");

    let positiveAuthorityVerified = false;
    await t.test("saved disabled identities and grants remain denied until both are independently enabled", async () => {
      for (const enabled of ["neither", "principal", "grant"]) {
        await db.admin.query("update studio_voice_principals set enabled=$2 where id=$1", [id.principal, enabled === "principal"]);
        await db.admin.query("update studio_voice_booking_grants set enabled=$2 where id=$1", [id.grant, enabled === "grant"]);
        const before = await counts();
        assert.equal((await call({ operation: "session", typeId: id.assignment })).response.status, 403);
        assert.deepEqual(await counts(), before);
      }
      await db.admin.query("update studio_voice_principals set enabled=true where id=$1", [id.principal]);
      await db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]);
      const authority = await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options);
      assert.deepEqual(authority, { workspaceId, publicId: publication.publicId, bindingId: id.principal, typeIds: [id.assignment], relation: { source: "studio_voice", sourceId: id.grant } });
      assert.notEqual(id.actor, id.organizer);
      positiveAuthorityVerified = true;
    });
    assert.equal(positiveAuthorityVerified, true, "resource-fence negatives require a verified positive authority baseline");

    await t.test("every current resource fence is checked before any session or durable budget write", async t => {
      const cases = [
        ["principal kill switch", "studio_voice_principals", id.principal, "kill_switch=true", "kill_switch=false"],
        ["grant kill switch", "studio_voice_booking_grants", id.grant, "kill_switch=true", "kill_switch=false"],
        ["service actor suspended", "workspace_users", id.actor, "status='suspended'", "status='active'"],
        ["publication disabled", "booking_publications", stored.id, "enabled=false", "enabled=true"],
        ["publication revision", "booking_publications", stored.id, "revision=revision+1", "revision=revision-1"],
        ["assignment disabled", "booking_publication_assignments", id.assignment, "enabled=false", "enabled=true"],
        ["assignment kind", "booking_publication_assignments", id.assignment, "kind='phone'", "kind='teams'"],
        ["assignment provider", "booking_publication_assignments", id.assignment, "provider='google'", "provider='microsoft'"],
        ["connection changed", "booking_calendar_connections", id.connection, "revision=revision+1", "revision=revision-1"],
        ["Teams unavailable", "booking_calendar_connections", id.connection, "calendars=jsonb_set(calendars,'{0,teamsSupported}','false'::jsonb)", "calendars=jsonb_set(calendars,'{0,teamsSupported}','true'::jsonb)"],
        ["production activation revoked", "booking_production_activations", id.activationRow, "status='revoked'", "status='active'"],
        ["production origin changed", "booking_production_activations", id.activationRow, "production_origin='https://foreign.fixture'", `production_origin='${origin}'`],
        ["QA workspace ineligible", "workspaces", workspaceId, "is_qa=true", "is_qa=false"],
        ["organizer identity disabled", "auth_identities", "organizer-identity", "disabled_at=now()", "disabled_at=null"],
        ["bot grant disabled", "bots", id.bot, "config=jsonb_set(config,'{booking,enabled}','false'::jsonb)", "config=jsonb_set(config,'{booking,enabled}','true'::jsonb)"],
      ];
      for (const [name, table, rowId, mutate, restore] of cases) await t.test(name, async () => {
        const predicate = rowId === "organizer-identity" ? "id=(select auth_identity_id from workspace_users where id=$1)" : "id=$1";
        const target = rowId === "organizer-identity" ? id.organizer : rowId;
        await db.admin.query(`update ${table} set ${mutate} where ${predicate}`, [target]);
        try {
          const before = await counts();
          assert.equal((await call({ operation: "session", typeId: id.assignment })).response.status, 403);
          assert.deepEqual(await counts(), before);
        } finally { await db.admin.query(`update ${table} set ${restore} where ${predicate}`, [target]); }
        assert.equal((await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options)).bindingId, id.principal,
          `${name}: the independently restored authority must be usable again`);
      });
    });

    await t.test("malformed saved bot grants are denied before any session or budget write", async t => {
      const savedGrant = { enabled: true, publicId: publication.publicId, channels: ["voice"], typeIds: [id.assignment] };
      const malformed: Array<[string, Record<string, unknown>]> = [
        ["object channels with a false voice value", { channels: { voice: false } }],
        ["string channels", { channels: "voice" }],
        ["null channels", { channels: null }],
        ["object typeIds with a false assignment value", { typeIds: { [id.assignment]: false } }],
        ["null typeIds", { typeIds: null }],
        ["empty typeIds", { typeIds: [] }],
        ["numeric typeIds entry", { typeIds: [id.assignment, 42] }],
        ["null typeIds entry", { typeIds: [id.assignment, null] }],
        ["object typeIds entry", { typeIds: [id.assignment, { id: id.assignment }] }],
        ["invalid UUID typeIds entry", { typeIds: [id.assignment, "not-a-uuid"] }],
        ["more than fifty typeIds", { typeIds: Array.from({ length: 51 }, () => id.assignment) }],
        ["null publicId", { publicId: null }],
        ["object publicId", { publicId: { value: publication.publicId } }],
        ["array publicId", { publicId: [publication.publicId] }],
      ];
      for (const [label, patch] of malformed) await t.test(label, async () => {
        await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: { ...savedGrant, ...patch } })]);
        try {
          const before = await counts();
          const result = await call({ operation: "session", typeId: id.assignment });
          assert.equal(result.response.status, 403, JSON.stringify(result.body));
          assert.deepEqual(await counts(), before);
        } finally { await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: savedGrant })]); }
        const restored = await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options);
        assert.deepEqual(restored.typeIds, [id.assignment]);
        assert.equal(restored.publicId, publication.publicId);
      });
      await t.test("numeric publicId is denied even when its text matches the persisted publication", async () => {
        const numericPublicId = "12345678901";
        await db.admin.query("update booking_publications set public_id=$2,config=jsonb_set(config,'{publicId}',to_jsonb($2::text)) where id=$1", [stored.id, numericPublicId]);
        try {
          await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: { ...savedGrant, publicId: Number(numericPublicId) } })]);
          const before = await counts();
          const result = await call({ operation: "session", typeId: id.assignment });
          assert.equal(result.response.status, 403, JSON.stringify(result.body));
          assert.deepEqual(await counts(), before);
          await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: { ...savedGrant, publicId: numericPublicId } })]);
          assert.equal((await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options)).publicId, numericPublicId,
            "the identical identifier is valid when saved as the required JSON string");
        } finally {
          await db.admin.query("update booking_publications set public_id=$2,config=jsonb_set(config,'{publicId}',to_jsonb($2::text)) where id=$1", [stored.id, publication.publicId]);
          await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: savedGrant })]);
        }
        assert.equal((await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options)).publicId, publication.publicId);
      });
    });

    await t.test("caller metadata, foreign type and unsupported operations cannot broaden the saved authority", async () => {
      for (const body of [
        { operation: "session", typeId: id.assignment, workspaceId: randomUUID() },
        { operation: "session", typeId: id.assignment, publicId: "foreign-publication" },
        { operation: "session", typeId: id.assignment, callerNumber: "+430000000" },
        { operation: "session", typeId: randomUUID() },
        { operation: "reschedule", token: "x".repeat(43), bookingId: randomUUID(), consent: true },
        { operation: "cancel", token: "x".repeat(43), bookingId: randomUUID(), consent: true },
      ]) {
        const before = await counts();
        const result = await call(body);
        assert.equal(result.response.status >= 400 && result.response.status < 500, true, JSON.stringify(result.body));
        assert.deepEqual(await counts(), before);
      }
      for (const headers of [{ cookie: "session=offline-untrusted" }, { origin: "https://foreign.fixture" }, { authorization: "" }] as Record<string, string>[]) {
        const before = await counts();
        assert.equal((await call({ operation: "session", typeId: id.assignment }, headers)).response.status, 403);
        assert.deepEqual(await counts(), before);
      }
      const before = await counts();
      const queryResult = await handleStudioVoiceBookingRequest(request({ operation: "session", typeId: id.assignment }, {}, localBearer(), `${origin}/api/integrations/booking/voice?workspaceId=${workspaceId}`), options);
      assert.equal(queryResult.status, 403);
      assert.deepEqual(await counts(), before);
      await assert.rejects(db.admin.query("update studio_voice_principals set workspace_id=$2 where id=$1", [id.principal, randomUUID()]), /STUDIO_VOICE_BINDING_IMMUTABLE/);
    });

    await t.test("the existing generic audience still uses its own unchanged booking authority", async () => {
      const body = { operation: "session", typeId: id.assignment };
      const before = await counts();
      const direct = await handleMachineBookingRequest(request(body, {}, localBearer(CRM_MACHINE_AUDIENCE)), "voice", options);
      const routed = await handleVoiceBookingRequest(request(body, {}, localBearer(CRM_MACHINE_AUDIENCE)), options);
      assert.equal(routed.status, direct.status);
      assert.deepEqual(await routed.json(), await direct.json());
      assert.equal(routed.status, 403, "the generic canary has no independent saved voice booking grant");
      assert.deepEqual(await counts(), before);
    });

    await t.test("revocation between fresh authority lookup and initial session insert rolls back the entire write", async () => {
      const body = { operation: "session", typeId: id.assignment, language: "en" };
      const inbound = request(body);
      const authority = await verifyStudioVoiceBookingAuthority(inbound, options);
      const before = await counts();
      await db.admin.query("update studio_voice_booking_grants set enabled=false where id=$1", [id.grant]);
      try {
        await assert.rejects(dispatchTrustedBookingTool(inbound, "voice", authority, body, options), /STUDIO_VOICE_BOOKING_DENIED/);
        assert.deepEqual(await counts(), before, "both the session insert and its rate reservation are rolled back");
      } finally { await db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]); }
    });

    const issue = async () => {
      const result = await call({ operation: "session", typeId: id.assignment, language: "en" });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(typeof result.body.token, "string");
      return result.body.token as string;
    };
    const startsAt = new Date(Date.now() + 3 * 86400_000);
    startsAt.setUTCHours(10, 0, 0, 0);
    let slot = 0;
    const nextSlot = () => new Date(startsAt.valueOf() + slot++ * 3600_000).toISOString();
    const hold = async (token: string, at: string, key = randomUUID()) => {
      const body = { operation: "hold", token, startsAt: at, recipientEmail: "visitor@studio.fixture", recipientName: "Offline visitor", idempotencyKey: key };
      const result = await call(body);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.booking, JSON.stringify(result.body));
      return { input: body, booking: result.body.booking as PublicBookingRecord };
    };
    const confirm = (token: string, booking: PublicBookingRecord) => ({ operation: "confirm", token, bookingId: booking.id, consent: true,
      summary: { startsAt: booking.startsAt, timeZone: booking.timeZone, kind: booking.kind, location: booking.location } });

    await t.test("the split-owner fixture needs only a private owner-to-owner execute bridge", async () => {
      const token = await issue();
      const sessionHash = createHash("sha256").update(token).digest("hex");
      const authorize = () => withTenantTransaction({ workspaceId, actorId: id.organizer }, tx => tx.queryOne<{ allowed: boolean }>(
        "select public.booking_channel_authorize_session((select id from booking_channel_sessions where token_hash=$1)) as allowed", [sessionHash]), pool);
      await assert.rejects(authorize(), (error: unknown) => {
        const rejected = error as { code?: string; message?: string };
        return rejected.code === "42501" && /permission denied for function _studio_voice_grant_allowed/.test(rejected.message ?? "");
      });
      // The real draft requires the existing common migration owner. This
      // deliberately stricter fixture gives ONLY the old canonical routine's
      // owner access to the new helper, whose own NOBYPASS execution is retained.
      // Neither the runtime nor PUBLIC receives access to that private helper.
      await db.admin.query("grant execute on function public._studio_voice_grant_allowed(uuid,uuid,uuid,uuid,bigint,uuid,uuid) to neondb_owner");
      const runtimeAccess = (await db.pool.query("select has_function_privilege(current_user,'public._studio_voice_grant_allowed(uuid,uuid,uuid,uuid,bigint,uuid,uuid)','EXECUTE') as allowed")).rows[0];
      assert.equal(runtimeAccess.allowed, false);
      assert.equal((await authorize())?.allowed, true);
    });

    const bindingImmutable = (error: unknown) => {
      const rejected = error as { code?: string; message?: string };
      return rejected.code === "42501" && rejected.message === "STUDIO_VOICE_BINDING_IMMUTABLE";
    };
    await t.test("a live session cannot adopt account, calendar, connection or service-actor changes under an existing ID", async t => {
      const token = await issue();
      const original = (await db.admin.query("select token_hash,binding_id,relation,publication_revision,organizer_id,expires_at from booking_channel_sessions where token_hash=$1", [createHash("sha256").update(token).digest("hex")])).rows[0];
      for (const [label, table, rowId, edit] of [
        ["grant calendar", "studio_voice_booking_grants", id.grant, "calendar_id='replacement-calendar'"],
        ["grant account", "studio_voice_booking_grants", id.grant, "account_id='replacement-account'"],
        ["grant connection", "studio_voice_booking_grants", id.grant, `connection_id='${randomUUID()}'::uuid`],
        ["grant connection revision", "studio_voice_booking_grants", id.grant, "connection_revision=connection_revision+1"],
        ["grant publication revision", "studio_voice_booking_grants", id.grant, "publication_revision=publication_revision+1"],
        ["grant original deadline", "studio_voice_booking_grants", id.grant, "valid_until=valid_until+interval '1 hour'"],
        ["grant authority reference", "studio_voice_booking_grants", id.grant, "authority_reference='replacement authority'"],
        ["principal actor", "studio_voice_principals", id.principal, `actor_user_id='${id.alternateActor}'::uuid`],
        ["principal original deadline", "studio_voice_principals", id.principal, "valid_until=valid_until+interval '1 hour'"],
        ["principal authority reference", "studio_voice_principals", id.principal, "authority_reference='replacement authority'"],
      ]) await t.test(label, async () => {
        await assert.rejects(db.admin.query(`update ${table} set ${edit} where id=$1`, [rowId]), bindingImmutable);
        const authority = await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options);
        assert.equal(authority.relation?.sourceId, id.grant);
        const current = (await db.admin.query("select token_hash,binding_id,relation,publication_revision,organizer_id,expires_at from booking_channel_sessions where token_hash=$1", [original.token_hash])).rows[0];
        assert.deepEqual(current, original);
      });
    });

    await t.test("hold and confirm retries reuse existing operation keys and status resolves the original hold key", async () => {
      const token = await issue(), holdKey = randomUUID(), first = await hold(token, nextSlot(), holdKey);
      const replay = await call(first.input);
      assert.equal((replay.body.booking as PublicBookingRecord).id, first.booking.id);
      const disagreement = await call({ ...first.input, recipientName: "Changed visitor" });
      assert.equal(disagreement.response.status, 409);
      const missingConsent = await call({ ...confirm(token, first.booking), consent: false });
      assert.equal(missingConsent.response.status, 409);
      const wrongSummary = await call({ ...confirm(token, first.booking), summary: { startsAt: first.booking.startsAt, kind: "phone", timeZone: "UTC", location: "" } });
      assert.equal(wrongSummary.response.status, 409);
      assert.equal(creates, 0);
      const confirmed = await call(confirm(token, first.booking));
      assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
      assert.equal((confirmed.body.booking as PublicBookingRecord).state, "confirmed");
      const again = await call(confirm(token, first.booking));
      assert.equal(again.response.status, 200, JSON.stringify(again.body));
      const status = await call({ operation: "status", token, idempotencyKey: holdKey });
      assert.equal((status.body.booking as PublicBookingRecord).id, first.booking.id);
      assert.equal((status.body.booking as PublicBookingRecord).state, "confirmed");
      assert.equal(creates, 1);
      const durable = (await db.admin.query(`select
        (select count(*)::int from booking_reservations where id=$1) reservations,
        (select count(*)::int from booking_operations where booking_id=$1 and kind='create') provider_operations,
        (select count(*)::int from booking_channel_operations where booking_id=$1 and action='hold') hold_operations,
        (select count(*)::int from booking_channel_operations where booking_id=$1 and action='confirm') confirm_operations`, [first.booking.id])).rows[0];
      assert.deepEqual(durable, { reservations: 1, provider_operations: 1, hold_operations: 1, confirm_operations: 1 });
      const own = (await db.admin.query("select s.id,s.token_hash,s.expires_at from booking_channel_sessions s join booking_channel_operations o on o.session_id=s.id where o.booking_id=$1 limit 1", [first.booking.id])).rows[0];
      for (const mutation of ["expires_at=expires_at+interval '1 second'", "request_count=0", "relation='{}'::jsonb", "binding_id='forged'"]) {
        await assert.rejects(withTenantTransaction({ workspaceId, actorId: id.organizer }, tx => tx.execute(`update booking_channel_sessions set ${mutation} where id=$1`, [own.id]), pool), /STUDIO_VOICE_BOOKING_DENIED/);
      }
      const stranger = await issue();
      assert.equal((await call({ operation: "status", token: stranger, bookingId: first.booking.id })).response.status, 404);
    });

    await t.test("disabling a saved grant fences an already issued token on the next request", async () => {
      const token = await issue(), held = await hold(token, nextSlot());
      await db.admin.query("update studio_voice_booking_grants set enabled=false where id=$1", [id.grant]);
      try {
        const before = creates;
        assert.equal((await call(confirm(token, held.booking))).response.status, 403);
        assert.equal((await call({ operation: "status", token, bookingId: held.booking.id })).response.status, 403);
        assert.equal(creates, before);
      } finally { await db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]); }
    });

    await t.test("revocation during the final availability forecast prevents the existing provider create", async () => {
      const token = await issue(), held = await hold(token, nextSlot()), forecast = gate();
      const before = creates;
      pauseBusy = () => forecast.wait();
      const pending = call(confirm(token, held.booking));
      try {
        await Promise.race([forecast.ready, pending.then(result => { throw new Error(`Confirmation ended before the forecast: ${JSON.stringify(result.body)}`); })]);
        await db.admin.query("update studio_voice_booking_grants set enabled=false where id=$1", [id.grant]);
        forecast.release();
        const result = await pending;
        assert.equal(result.response.status, 200, JSON.stringify(result.body));
        assert.equal((result.body.booking as PublicBookingRecord).state, "expired");
        assert.equal(creates, before);
        const operation = (await db.admin.query("select state,error_code from booking_operations where booking_id=$1", [held.booking.id])).rows[0];
        assert.equal(operation.state, "rejected");
        assert.equal(operation.error_code, "BOOKING_SESSION_INVALID");
      } finally {
        forecast.release(); pauseBusy = undefined;
        await db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]);
      }
    });
    await t.test("a malformed saved bot grant during the final forecast fences the original session before provider create", async () => {
      const token = await issue(), held = await hold(token, nextSlot()), forecast = gate();
      const sessionHash = createHash("sha256").update(token).digest("hex");
      const original = (await db.admin.query("select token_hash,binding_id,relation,publication_revision,assignment_id,organizer_id,expires_at from booking_channel_sessions where token_hash=$1", [sessionHash])).rows[0];
      const before = await counts(), beforeCreates = creates;
      const savedGrant = { enabled: true, publicId: publication.publicId, channels: ["voice"], typeIds: [id.assignment] };
      pauseBusy = () => forecast.wait();
      const pending = call(confirm(token, held.booking));
      try {
        await Promise.race([forecast.ready, pending.then(result => { throw new Error(`Confirmation ended before the forecast: ${JSON.stringify(result.body)}`); })]);
        await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: { ...savedGrant, channels: { voice: false } } })]);
        forecast.release();
        const result = await pending;
        assert.equal(result.response.status, 200, JSON.stringify(result.body));
        assert.equal((result.body.booking as PublicBookingRecord).id, held.booking.id);
        assert.equal((result.body.booking as PublicBookingRecord).state, "expired");
        assert.equal(creates, beforeCreates);
        assert.equal((await counts()).sessions, before.sessions, "the existing token is used without issuing a replacement session");
        const operation = (await db.admin.query("select state,error_code from booking_operations where booking_id=$1", [held.booking.id])).rows;
        assert.deepEqual(operation, [{ state: "rejected", error_code: "BOOKING_SESSION_INVALID" }]);
        const preserved = (await db.admin.query("select token_hash,binding_id,relation,publication_revision,assignment_id,organizer_id,expires_at from booking_channel_sessions where token_hash=$1", [sessionHash])).rows[0];
        assert.deepEqual(preserved, original);
        assert.equal((await db.admin.query("select count(*)::int as n from booking_channel_operations where booking_id=$1 and action='confirm'", [held.booking.id])).rows[0].n, 1);
      } finally {
        forecast.release(); pauseBusy = undefined;
        await db.admin.query("update bots set config=$2::jsonb where id=$1", [id.bot, JSON.stringify({ booking: savedGrant })]);
      }
    });
    await t.test("the draft preserves an existing channel in another workspace", async () => {
      const foreign = { workspaceId: randomUUID(), userId: randomUUID(), connectionId: randomUUID(), assignmentId: randomUUID() };
      await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,is_qa) values($1,'SYNTHETIC foreign compatibility','self_service_customer','general_company',true)", [foreign.workspaceId]);
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC foreign organizer','foreign@example.invalid','owner','customer_owner','active')", [foreign.userId, foreign.workspaceId]);
      await db.admin.query("insert into workspace_module_settings(workspace_id,module_key,enabled) values($1,'calendar',true)", [foreign.workspaceId]);
      await db.admin.query(`insert into booking_calendar_connections(id,workspace_id,user_id,provider,status,account_id,write_calendar_id,calendars)
        values($1,$2,$3,'google','connected','synthetic-foreign-account','synthetic-foreign-calendar',$4::jsonb)`,
        [foreign.connectionId, foreign.workspaceId, foreign.userId, JSON.stringify([{ id: "synthetic-foreign-calendar", name: "SYNTHETIC foreign calendar", canRead: true, canWrite: true, protectedReadOnly: false, teamsSupported: false, meetSupported: true }])]);
      const session: AppSession = { ...actorSession(foreign.userId), workspaceId: foreign.workspaceId, productRole: "customer_owner", productPermissions: getProductRoleCapabilities("customer_owner") };
      await saveBookingRules(session, { rules: { timeZone: "UTC", minNoticeMinutes: 0, preparationMinutes: 0, followupMinutes: 0,
        maxAdvanceDays: 366, workingHours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: "09:00", end: "17:00" })) } }, pool);
      await saveBookingSetup(session, { scope: "company", kind: "*", section: "communication", value: { enabled: false } }, pool);
      const draft = await getBookingPublication(session, pool);
      const publication = { ...draft.publication, enabled: true, channels: { ...draft.publication.channels, link: true },
        assignments: [{ id: foreign.assignmentId, kind: "phone" as const, provider: "google" as const, organizerId: foreign.userId }] };
      await saveBookingPublication(session, { publication, expectedRevision: 0 }, pool);
      const foreignOptions = { ...options, connectionResolver: async () => ({ connectionId: foreign.connectionId, calendarId: "synthetic-foreign-calendar", revision: 1 }) };
      const inbound = request({}, { origin });
      const issued = await startBookingChannelSession(inbound, { publicId: publication.publicId, typeId: foreign.assignmentId, channel: "link", language: "en" }, foreignOptions);
      const held = await dispatchBookingChannelAction(issued.token, "hold", { startsAt: nextSlot(), recipientEmail: "foreign@example.invalid", recipientName: "SYNTHETIC visitor", idempotencyKey: randomUUID() }, inbound, foreignOptions) as { booking: PublicBookingRecord };
      assert.equal(held.booking.state, "held");
      const before = creates;
      const confirmed = await dispatchBookingChannelAction(issued.token, "confirm", { bookingId: held.booking.id, consent: true }, inbound, foreignOptions) as { booking: PublicBookingRecord };
      assert.equal(confirmed.booking.state, "confirmed");
      assert.equal(creates, before + 1);
      const authority = await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options);
      assert.equal(authority.workspaceId, workspaceId);
      assert.equal(authority.typeIds.includes(foreign.assignmentId), false);
    });
    await t.test("an independently inserted expired grant cannot replace current authority", async () => {
      const expiredId = randomUUID();
      await db.admin.query("update studio_voice_booking_grants set enabled=false where id=$1", [id.grant]);
      try {
        await db.admin.query(`insert into studio_voice_booking_grants select (jsonb_populate_record(null::studio_voice_booking_grants,
          to_jsonb(g)||jsonb_build_object('id',$2::uuid,'enabled',true,'valid_from',now()-interval '1 hour','valid_until',now()-interval '1 second'))).*
          from studio_voice_booking_grants g where id=$1`, [id.grant, expiredId]);
        const before = await counts();
        assert.equal((await call({ operation: "session", typeId: id.assignment })).response.status, 403);
        assert.deepEqual(await counts(), before);
      } finally {
        await db.admin.query("update studio_voice_booking_grants set enabled=false,revoked_at=now() where id=$1", [expiredId]);
        await db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]);
      }
      assert.equal((await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options)).relation?.sourceId, id.grant);
    });
    await t.test("terminal grant revocation requires a new grant and an original session cannot adopt its replacement", async () => {
      const token = await issue(), held = await hold(token, nextSlot()), replacementId = randomUUID();
      const before = creates;
      await db.admin.query("update studio_voice_booking_grants set enabled=false,revoked_at=now() where id=$1", [id.grant]);
      assert.equal((await call(confirm(token, held.booking))).response.status, 403);
      await assert.rejects(db.admin.query("update studio_voice_booking_grants set revoked_at=null where id=$1", [id.grant]), bindingImmutable);
      await assert.rejects(db.admin.query("update studio_voice_booking_grants set enabled=true where id=$1", [id.grant]), bindingImmutable);
      await db.admin.query(`insert into studio_voice_booking_grants select (jsonb_populate_record(null::studio_voice_booking_grants,
        to_jsonb(g)||jsonb_build_object('id',$2::uuid,'enabled',true,'revoked_at',null))).*
        from studio_voice_booking_grants g where id=$1`, [id.grant, replacementId]);
      const replacement = await verifyStudioVoiceBookingAuthority(request({ operation: "session", typeId: id.assignment }), options);
      assert.equal(replacement.relation?.sourceId, replacementId);
      const oldStatus = await call({ operation: "status", token, bookingId: held.booking.id });
      assert.equal(oldStatus.response.status >= 400, true, JSON.stringify(oldStatus.body));
      assert.equal(oldStatus.body.booking, undefined);
      assert.equal(creates, before);
      const original = (await db.admin.query("select relation from booking_channel_sessions where token_hash=$1", [createHash("sha256").update(token).digest("hex")])).rows[0];
      assert.equal(original.relation.sourceId, id.grant);
      const freshToken = await issue(), freshHold = await hold(freshToken, nextSlot());
      const freshStatus = await call({ operation: "status", token: freshToken, bookingId: freshHold.booking.id });
      assert.equal(freshStatus.response.status, 200);
      assert.equal((freshStatus.body.booking as PublicBookingRecord).id, freshHold.booking.id);
      await db.admin.query("update studio_voice_principals set enabled=false,revoked_at=now() where id=$1", [id.principal]);
      assert.equal((await call(confirm(freshToken, freshHold.booking))).response.status, 403);
      await assert.rejects(db.admin.query("update studio_voice_principals set revoked_at=null where id=$1", [id.principal]), bindingImmutable);
      await assert.rejects(db.admin.query("update studio_voice_principals set enabled=true where id=$1", [id.principal]), bindingImmutable);
      assert.equal(creates, before);
    });
    await t.test("deletion and truncation preserve authority tombstones and prevent same-ID resurrection", async () => {
      const before = (await db.admin.query("select (select count(*)::int from studio_voice_principals) principals,(select count(*)::int from studio_voice_booking_grants) grants")).rows[0];
      await assert.rejects(db.admin.query("delete from studio_voice_booking_grants where id=$1", [id.grant]), bindingImmutable);
      await assert.rejects(db.admin.query("delete from studio_voice_principals where id=$1", [id.principal]), bindingImmutable);
      await assert.rejects(db.admin.query("truncate table studio_voice_booking_grants"), bindingImmutable);
      await assert.rejects(db.admin.query("truncate table studio_voice_principals,studio_voice_booking_grants"), bindingImmutable);
      await assert.rejects(db.admin.query("insert into studio_voice_booking_grants select * from studio_voice_booking_grants where id=$1", [id.grant]), /duplicate key/);
      assert.deepEqual((await db.admin.query("select (select count(*)::int from studio_voice_principals) principals,(select count(*)::int from studio_voice_booking_grants) grants")).rows[0], before);
      assert.equal((await call({ operation: "session", typeId: id.assignment })).response.status, 403);
    });
    assert.equal(updates, 0);
    assert.equal(deletes, 0);
    assert.equal(networkRequests, 0);
  } finally { pauseBusy = undefined; globalThis.fetch = previousFetch; process.env = previous; await db.stop(); }
});
