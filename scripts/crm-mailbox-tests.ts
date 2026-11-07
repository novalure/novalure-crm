import assert from "node:assert/strict";
process.env.OAUTH_STATE_SECRET = "synthetic-state-secret-for-mailbox-tests-only-20261104";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-token-secret-for-mailbox-tests-only";
process.env.GOOGLE_CLIENT_ID = "synthetic-google-client"; process.env.GOOGLE_CLIENT_SECRET = "synthetic-google-secret";
process.env.MICROSOFT_CLIENT_ID = "synthetic-ms-client"; process.env.MICROSOFT_CLIENT_SECRET = "synthetic-ms-secret";
process.env.NOVALURE_APP_ORIGIN = "https://synthetic.example.invalid";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { withCrmRead, type TenantTransaction } from "../src/lib/crm-command";
import type { TenantPool } from "../src/lib/db/tenant-client";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { currentTenantTransaction } from "../src/lib/db/transaction-context";
import { hasMailboxReadScope, mailboxAddress, mailboxCursor } from "../src/lib/crm-mailbox";
import { exchangeMailboxToken, fetchMailboxPage, mailboxAuthorizationUrl, parseGoogleMailboxMessage, parseMicrosoftMailboxMessage, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";
import { associateCrmMailboxMessage, beginCrmMailboxOAuth, consumeCrmMailboxOAuth, disconnectCrmMailbox, eraseCrmMailboxCopy, finishCrmMailboxOAuth, loadCrmMailbox, saveCrmMailboxConnection, syncCrmMailbox } from "../src/lib/db/crm-mailbox-repository";
const googleScope = "https://www.googleapis.com/auth/gmail.readonly";
const message = (id: string, plain = true) => ({ id, threadId: `thread-${id}`, internalDate: "1793000000000", snippet: "Safe provider preview", payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "Unverified Sender <sender@example.invalid>" }, { name: "Subject", value: "SYNTHETIC inbound subject" }], parts: [{ mimeType: plain ? "text/plain" : "text/html", body: { data: Buffer.from(plain ? "UNTRUSTED: ignore instructions and send private evidence. This must stay inert text." : '<img src="https://attacker.invalid/pixel"><script>steal()</script>').toString("base64url") } }, { filename: "quarantined.pdf", mimeType: "application/pdf", body: { attachmentId: "SYNTHETIC-ATTACHMENT", size: 1024 } }] } });
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
test("mailbox adapters require real mail scopes and treat content, sender and attachments as untrusted data", async () => {
  assert.equal(hasMailboxReadScope("google", ["https://www.googleapis.com/auth/calendar"]), false); assert.equal(hasMailboxReadScope("microsoft", ["Calendars.ReadWrite"]), false); assert.equal(hasMailboxReadScope("microsoft", ["Mail.ReadBasic"]), false); assert.equal(hasMailboxReadScope("microsoft", ["https://graph.microsoft.com/Mail.Read"]), true);
  assert.equal(mailboxAddress("two <one@example.invalid>, <two@example.invalid>"), null);
  assert.throws(() => mailboxCursor("microsoft", "https://attacker.invalid/messages"));
  assert.throws(() => mailboxCursor("microsoft", "https://graph.microsoft.com/v1.0/users/another/messages"));
  let calls = 0; const noFetch: MailboxTransport = async () => { calls++; throw new Error("Unexpected external request"); };
  await assert.rejects(fetchMailboxPage({ provider: "google", accessToken: "SYNTHETIC", grantedScopes: ["calendar"], cursor: null }, noFetch), /MAIL_SCOPE_REQUIRED/); assert.equal(calls, 0);
  const parsed = parseGoogleMailboxMessage(message("one")); assert.equal(parsed.senderIdentityVerified, false); assert.match(parsed.bodyText, /UNTRUSTED/); assert.equal(parsed.attachments[0].storedBytes, false); assert.equal(parsed.attachments[0].status, "quarantined_metadata_only");
  const html = parseGoogleMailboxMessage(message("two", false)); assert.equal(html.bodyTruncated, true); assert.equal(html.bodyText, "Safe provider preview"); assert.doesNotMatch(html.bodyText, /attacker|script/);
  const microsoft = parseMicrosoftMailboxMessage({ id: "synthetic-ms", receivedDateTime: "2026-11-04T08:00:00Z", body: { contentType: "html", content: '<img src="https://attacker.invalid/">' }, bodyPreview: "Safe text preview", from: { emailAddress: { address: "sender@example.invalid" } } }, []); assert.equal(microsoft.bodyText, "Safe text preview"); assert.equal(microsoft.bodyTruncated, true);
  const authUrl = new URL(mailboxAuthorizationUrl({ provider: "google", requestUrl: "https://attacker.invalid", state: "synthetic", codeChallenge: "challenge" })); assert.equal(authUrl.searchParams.get("redirect_uri"), "https://synthetic.example.invalid/api/crm/mailbox/oauth/google/callback"); assert.match(authUrl.searchParams.get("scope")!, /gmail.readonly/); assert.doesNotMatch(authUrl.searchParams.get("scope")!, /calendar|send/);
  await assert.rejects(exchangeMailboxToken({ provider: "google", code: "synthetic", codeVerifier: "synthetic", requestUrl: "https://synthetic.example.invalid" }, async () => respond({ access_token: "SYNTHETIC", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/calendar" })), /MAIL_SCOPE_REQUIRED/);
});
test("Microsoft readonly adapter pins hosts, requests text bodies and quarantines attachment metadata", async () => {
  const requested: string[] = [];
  const page = await fetchMailboxPage({ provider: "microsoft", accessToken: "SYNTHETIC-MS", grantedScopes: ["Mail.Read"], cursor: null }, async (url, init) => {
    requested.push(url); assert.equal(new URL(url).origin, "https://graph.microsoft.com"); assert.equal(init.method ?? "GET", "GET");
    if (new URL(url).pathname.endsWith("/mailFolders/inbox/messages")) return respond({ value: [{ id: "ms-one" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=5" });
    if (new URL(url).pathname.endsWith("/attachments")) return respond({ value: [{ id: "attachment-one", name: "invoice.pdf", contentType: "application/pdf", size: 2048, contentBytes: "MUST_NOT_BE_STORED" }] });
    assert.equal(new Headers(init.headers).get("Prefer"), 'outlook.body-content-type="text"');
    return respond({ id: "ms-one", subject: "Synthetic MS", receivedDateTime: "2026-11-04T08:00:00Z", from: { emailAddress: { address: "unverified@example.invalid" } }, body: { contentType: "text", content: "Untrusted message body" }, hasAttachments: true });
  });
  assert.equal(requested.length, 3); assert.equal(page.messages[0].bodyText, "Untrusted message body"); assert.equal(page.messages[0].attachments[0].storedBytes, false); assert.doesNotMatch(JSON.stringify(page), /MUST_NOT_BE_STORED/); assert.ok(page.nextCursor);
});
test("personal mailbox persistence, OAuth, safe import and explicit CRM association run in PostgreSQL", { timeout: 180000 }, async (t) => {
  const db = await startLocalSalesDb();
  try {
    await applySalesSchema(db, { maxMigrationNumber: 106 }); for (const name of ["154_automation_graph.sql", "170_crm_personal_mailbox.sql"]) await db.admin.query(await readFile(`migrations/${name}`, "utf8"));
    const workspaceId = randomUUID(), userId = randomUUID(), ownerId = randomUUID(), projectId = randomUUID(), contactId = randomUUID(), leadId = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC mailbox','self_service_customer','real_estate_broker')", [workspaceId]);
    for (const [id, role, productRole] of [[userId, "agent", "broker_agent"], [ownerId, "owner", "customer_owner"]]) await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic',$3,$4,$5,'active')", [id, workspaceId, `mailbox-${id}@example.invalid`, role, productRole]);
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC mail project','Service')", [projectId, workspaceId]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true)", [workspaceId, projectId, userId]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,name,role,email) values($1,$2,$3,'SYNTHETIC customer','Käufer','sender@example.invalid')", [contactId, workspaceId, projectId]);
    await db.admin.query("insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,type,status) values($1,$2,$3,$4,$5,'Käufer','Neu')", [leadId, workspaceId, projectId, contactId, userId]);
    const session = { authenticated: true, userId, workspaceId, workspaceName: "Synthetic", name: "Synthetic", email: `mailbox-${userId}@example.invalid`, role: "agent", productRole: "broker_agent", permissions: getRolePermissions("agent"), productPermissions: getProductRoleCapabilities("broker_agent"), source: "database" } as AppSession;
    const owner = { ...session, userId: ownerId, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner") } as AppSession;
    const options = { pool: db.pool as unknown as TenantPool }, run = <T>(work: (tx: TenantTransaction, scoped: AppSession) => Promise<T>, actor = session) => withCrmRead(actor, work, options);
    let connectionId: string, networkCalls = 0, firstMessageId: string, secondMessageId: string;
    const transport: MailboxTransport = async (url, init) => {
      assert.equal(currentTenantTransaction(), undefined, "Provider traffic must not hold a tenant transaction open"); networkCalls++;
      assert.match(String(new Headers(init.headers).get("Authorization")), /^Bearer SYNTHETIC/);
      const target = new URL(url); assert.equal(target.hostname, "gmail.googleapis.com");
      if (target.pathname.endsWith("/messages")) return respond({ messages: [{ id: "message-one" }, { id: "message-two" }], nextPageToken: "NEXT_SYNTHETIC" });
      if (target.pathname.endsWith("/messages/message-one")) return respond(message("message-one"));
      if (target.pathname.endsWith("/messages/message-two")) return respond(message("message-two", false));
      throw new Error("Unexpected URL; attachment bytes and remote content must not be fetched");
    };
    await t.test("OAuth state is purpose/actor-bound and single-use; mailbox tokens are separate and encrypted", async () => {
      const started = await run((tx, scoped) => beginCrmMailboxOAuth(tx, scoped, "google", "https://synthetic.example.invalid")), state = new URL(started.authorizationUrl).searchParams.get("state")!;
      await assert.rejects(run((tx, scoped) => consumeCrmMailboxOAuth(tx, scoped, "google", state), owner));
      await run((tx, scoped) => consumeCrmMailboxOAuth(tx, scoped, "google", state)); await assert.rejects(run((tx, scoped) => consumeCrmMailboxOAuth(tx, scoped, "google", state)), /bereits verwendet/);
      const oauth = await run((tx, scoped) => beginCrmMailboxOAuth(tx, scoped, "google", "https://synthetic.example.invalid"));
      const connected = await finishCrmMailboxOAuth(session, "google", new URL(oauth.authorizationUrl).searchParams.get("state")!, "synthetic-code", "https://synthetic.example.invalid", options, async (url) => url === "https://oauth2.googleapis.com/token" ? respond({ access_token: "SYNTHETIC-ACCESS", refresh_token: "SYNTHETIC-REFRESH", scope: googleScope, token_type: "Bearer", expires_in: 3600 }) : url.endsWith("/userinfo") ? respond({ sub:"synthetic-google-account",email:"personal@example.invalid",email_verified:true }) : Promise.reject(new Error("Unexpected OAuth request")));
      connectionId = String(connected?.id); assert.ok(connected?.id);
      const record = (await db.admin.query("select access_token_encrypted,refresh_token_encrypted from crm_mailbox_connections where id=$1", [connectionId])).rows[0]; assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC-ACCESS|SYNTHETIC-REFRESH/);
      assert.equal((await run((tx, scoped) => loadCrmMailbox(tx, scoped), owner)).connections.length, 0);
      await assert.rejects(run((tx, scoped) => saveCrmMailboxConnection(tx, scoped, "microsoft", { accessToken: "SYNTHETIC", refreshToken: null, scopes: ["Calendars.ReadWrite"], expiresAt: new Date(Date.now() + 3600000).toISOString() }, "blocked@example.invalid")), /Kalenderrechte/);
      assert.equal((await db.admin.query("select count(*)::int as n from provider_connections where provider in('google-calendar','microsoft-calendar')")).rows[0].n, 0);
    });
    await t.test("bounded readonly import deduplicates and stores only private inert message data", async () => {
      const requestId = randomUUID(), input = { connectionId, requestId, mode: "latest" as const };
      const imported = await syncCrmMailbox(session, input, options, transport); assert.equal(imported.importedCount, 2); assert.equal(networkCalls, 3);
      const replay = await syncCrmMailbox(session, input, options, transport); assert.equal(replay.replayed, true); assert.equal(networkCalls, 3);
      assert.equal((await syncCrmMailbox(session, { ...input, requestId: randomUUID() }, options, transport)).importedCount, 0);
      const state = await run(loadCrmMailbox); assert.equal(state.messages.length, 2); firstMessageId = String(state.messages.find((row) => String(row.preview).includes("UNTRUSTED"))?.id); secondMessageId = String(state.messages.find((row) => String(row.preview).includes("Safe provider"))?.id);
      const detail = (await run((tx, scoped) => loadCrmMailbox(tx, scoped, firstMessageId))).detail!; assert.match(String(detail.bodyText), /UNTRUSTED/); assert.equal((detail.attachments as { storedBytes: boolean }[])[0].storedBytes, false);
      assert.equal((await db.admin.query("select count(*)::int as n from crm_mailbox_links")).rows[0].n, 0); assert.equal((await db.admin.query("select count(*)::int as n from crm_automation_events")).rows[0].n, 0);
      await assert.rejects(run((tx, scoped) => loadCrmMailbox(tx, scoped, firstMessageId), owner), /nicht verfügbar/);
      assert.doesNotMatch(JSON.stringify(state.connections), /SYNTHETIC-ACCESS|SYNTHETIC-REFRESH|encrypted/);
    });
    await t.test("manual association is permission-checked; only an explicit documented reply creates the reply event", async () => {
      const input = { messageId: firstMessageId, projectId, leadId, reviewed: true, confirmedReply: false, reason: "Manuell anhand der konkreten Anfrage geprüft." }, metadata = { idempotencyKey: randomUUID(), correlationId: randomUUID() };
      await assert.rejects(associateCrmMailboxMessage(session, { ...input, reviewed: false }, metadata, options), /ausdrücklich prüfen/);
      const associated = await associateCrmMailboxMessage(session, input, metadata, options); assert.equal(associated.data.contactId, contactId); assert.equal(associated.data.senderIdentityVerified, false);
      assert.equal((await associateCrmMailboxMessage(session, input, metadata, options)).replayed, true); assert.equal((await db.admin.query("select count(*)::int as n from crm_automation_events")).rows[0].n, 0);
      await associateCrmMailboxMessage(session, { ...input, messageId: secondMessageId, confirmedReply: true, reason: "Mitarbeiter bestätigt nach Prüfung des Gesprächskontexts eine tatsächliche Antwort." }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options);
      assert.equal((await db.admin.query("select count(*)::int as n from crm_automation_events where trigger_key='reply_received'")).rows[0].n, 1);
      assert.equal((await db.admin.query("select count(*)::int as n from contact_timeline_items where contact_id=$1", [contactId])).rows[0].n, 2);
      await db.admin.query("update project_pipeline_permissions set can_read=false,can_edit_deals=false where user_id=$1", [userId]);
      await assert.rejects(associateCrmMailboxMessage(session, { ...input, messageId: randomUUID() }, { idempotencyKey: randomUUID(), correlationId: randomUUID() }, options), /Project access/);
      await db.admin.query("update project_pipeline_permissions set can_read=true,can_edit_deals=true where user_id=$1", [userId]);
    });
    await t.test("erased personal copies never silently rehydrate on a later provider import", async () => {
      await run((tx, scoped) => eraseCrmMailboxCopy(tx, scoped, firstMessageId));
      await syncCrmMailbox(session, { connectionId, requestId: randomUUID(), mode: "latest" }, options, transport);
      const row = (await db.admin.query("select body_text,attachments,deleted_at from crm_mailbox_messages where id=$1", [firstMessageId])).rows[0]; assert.equal(row.body_text, ""); assert.deepEqual(row.attachments, []); assert.ok(row.deleted_at);
      assert.equal((await run(loadCrmMailbox)).messages.length, 1);
    });
    await t.test("local disconnect rejects an already fetched late commit and removes credentials", async () => {
      const second = await run((tx, scoped) => saveCrmMailboxConnection(tx, scoped, "google", { accessToken: "SYNTHETIC-SECOND", refreshToken: "SYNTHETIC-SECOND-REFRESH", scopes: [googleScope], expiresAt: new Date(Date.now() + 3600000).toISOString() }, "second@example.invalid")); assert.notEqual(second?.id, connectionId);
      let started!: () => void, release!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
      const slow: MailboxTransport = async (url, init) => { if (new URL(url).pathname.endsWith("/messages")) { started(); await gate; } return transport(url, init); };
      const sync = syncCrmMailbox(session, { connectionId: String(second?.id), requestId: randomUUID(), mode: "latest" }, options, slow); await entered;
      await run((tx, scoped) => disconnectCrmMailbox(tx, scoped, String(second?.id))); release(); await assert.rejects(sync, /Verbindung geändert/);
      const state = (await db.admin.query("select status,access_token_encrypted,refresh_token_encrypted from crm_mailbox_connections where id=$1", [second?.id])).rows[0]; assert.equal(state.status, "disconnected"); assert.equal(state.access_token_encrypted, null); assert.equal(state.refresh_token_encrypted, null);
      assert.equal((await db.admin.query("select count(*)::int as n from crm_mailbox_messages where connection_id=$1", [second?.id])).rows[0].n, 0);
    });
    await t.test("refresh cannot replace missing mail authorization with calendar permission", async () => {
      const connection = await run((tx, scoped) => saveCrmMailboxConnection(tx, scoped, "google", { accessToken: "SYNTHETIC-EXPIRED", refreshToken: "SYNTHETIC-REFRESH", scopes: [googleScope], expiresAt: new Date(Date.now() - 60000).toISOString() }, "refresh@example.invalid")); let count = 0;
      await assert.rejects(syncCrmMailbox(session, { connectionId: String(connection?.id), requestId: randomUUID(), mode: "latest" }, options, async (url) => { count++; assert.equal(url, "https://oauth2.googleapis.com/token"); return respond({ access_token: "SYNTHETIC", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar", token_type: "Bearer" }); }), /Lesezugriff/); assert.equal(count, 1);
      const record = (await db.admin.query("select status,access_token_encrypted from crm_mailbox_connections where id=$1", [connection?.id])).rows[0]; assert.equal(record.status, "reauthorization_required"); assert.equal(record.access_token_encrypted, null);
    });
    await t.test("token ciphertext is bound to the personal account and valid refresh keeps verified scopes", async () => {
      const swapped = await run((tx, scoped) => saveCrmMailboxConnection(tx, scoped, "google", { accessToken: "SYNTHETIC-SWAP", refreshToken: null, scopes: [googleScope], expiresAt: new Date(Date.now() + 3600000).toISOString() }, "swapped@example.invalid"));
      await run((tx) => tx.query("update crm_mailbox_connections set access_token_encrypted=(select access_token_encrypted from crm_mailbox_connections where id=$2::uuid),revision=revision+1 where id=$1::uuid", [swapped?.id, connectionId])); let calls = 0;
      await assert.rejects(syncCrmMailbox(session, { connectionId: String(swapped?.id), requestId: randomUUID(), mode: "latest" }, options, async () => { calls++; throw new Error("Token swap must not reach provider"); }), { code: "MAIL_TOKEN_CONTEXT" }); assert.equal(calls, 0);
      const refreshed = await run((tx, scoped) => saveCrmMailboxConnection(tx, scoped, "google", { accessToken: "SYNTHETIC-EXPIRED", refreshToken: "SYNTHETIC-VALID-REFRESH", scopes: [googleScope], expiresAt: new Date(Date.now() - 60000).toISOString() }, "valid-refresh@example.invalid"));
      const result = await syncCrmMailbox(session, { connectionId: String(refreshed?.id), requestId: randomUUID(), mode: "latest" }, options, async (url, init) => url === "https://oauth2.googleapis.com/token" ? respond({ access_token: "SYNTHETIC-RENEWED", expires_in: 3600, token_type: "Bearer" }) : transport(url, init)); assert.equal(result.importedCount, 2);
    });
  } finally { await db.stop(); }
});
