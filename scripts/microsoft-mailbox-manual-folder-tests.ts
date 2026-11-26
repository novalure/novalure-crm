import assert from "node:assert/strict";
import { test } from "node:test";
import { mailboxCursor } from "../src/lib/crm-mailbox";
import { fetchMailboxPage, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";

const base = "https://graph.microsoft.com/v1.0/me";
const inbox = "SYNTHETIC-Inbox/ABC+=";
const encoded = encodeURIComponent(inbox);
const scopes = ["Mail.Read"];
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const details = { id: "message-one", parentFolderId: inbox, receivedDateTime: "2026-11-25T12:00:00Z", body: { contentType: "text", content: "synthetic body" }, hasAttachments: true };
const input = (cursor: string | null = null) => ({ provider: "microsoft" as const, accessToken: "SYNTHETIC", grantedScopes: scopes, cursor, immutableIds: true });

test("saved manual cursor must be bound to Inbox, not the whole mailbox or another folder", async () => {
  const bad = [`${base}/messages?$skip=5`, `https://attacker.invalid/v1.0/me/mailFolders/inbox/messages?$skip=5`, `https://user@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=5`, `${base}/mailFolders/inbox/messages?$skip=5#fragment`, `${base}/mailFolders/inbox/messages/../messages?$skip=5`, `${base}/mailFolders/inbox/messages?$skip=5\n`];
  for (const cursor of bad) {
    let calls = 0;
    await assert.rejects(fetchMailboxPage(input(cursor), async () => { calls++; return respond({}); }));
    assert.equal(calls, 0, cursor);
  }
  for (const cursor of [`${base}/mailFolders/other/messages?$skip=5`, `${base}/mailFolders/${encodeURIComponent(inbox.toLowerCase())}/messages?$skip=5`, `${base}/mailFolders/${encodeURIComponent(encoded)}/messages?$skip=5`]) {
    const calls: string[] = [];
    await assert.rejects(fetchMailboxPage(input(cursor), async url => { calls.push(url); return respond({ id: inbox }); }));
    assert.deepEqual(calls, [`${base}/mailFolders/inbox?$select=id`]);
  }
});

test("authenticated Inbox alias or exact case-sensitive Inbox ID keeps opaque next links unchanged", async () => {
  const alias = `${base}/mailFolders/inbox/messages?$skip=5&$select=id`;
  const specific = `${base}/mailFolders/${encoded}/messages?$skip=10&opaque=%2B%2F`;
  assert.equal(mailboxCursor("microsoft", alias, inbox), alias);
  assert.equal(mailboxCursor("microsoft", specific, inbox), specific);
  assert.throws(() => mailboxCursor("microsoft", specific));
  for (const cursor of [alias, specific]) {
    const calls: string[] = [];
    const next = cursor === alias ? specific : `${base}/mailFolders/${encoded}/messages?$skip=15`;
    const page = await fetchMailboxPage(input(cursor), async url => {
      calls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      assert.equal(url, cursor);
      return respond({ value: [], "@odata.nextLink": next });
    });
    assert.equal(page.nextCursor, next);
    assert.equal(page.verifiedInboxId, inbox);
    assert.equal(calls.length, 2);
  }
});

test("unchanged manual next links fail before detail fetching", async () => {
  for (const cursor of [null, `${base}/mailFolders/inbox/messages?$skip=5`]) {
    const urls: string[] = [];
    await assert.rejects(fetchMailboxPage(input(cursor), async url => {
      urls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      return respond({ value: [{ id: "message-one" }], "@odata.nextLink": url });
    }), /MAIL_CURSOR_STALLED/);
    assert.equal(urls.length, 2);
  }
});

test("provider continuation is validated before fetching message details", async () => {
  for (const next of [`${base}/messages?$skip=5`, `${base}/mailFolders/other/messages?$skip=5`, "", null]) {
    const calls: string[] = [];
    await assert.rejects(fetchMailboxPage(input(), async url => {
      calls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      return respond({ value: [{ id: "message-one" }], "@odata.nextLink": next });
    }));
    assert.equal(calls.length, 2);
  }
});

test("details and attachment metadata use verified folder; identity and folder must match", async () => {
  const calls: string[] = [];
  const transport: MailboxTransport = async (url, init) => {
    calls.push(url);
    assert.equal(new URL(url).origin, "https://graph.microsoft.com");
    assert.match(String(new Headers(init.headers).get("Prefer")), /IdType="ImmutableId"/);
    if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
    if (url.startsWith(`${base}/mailFolders/inbox/messages?`)) return respond({ value: [{ id: "message-one" }] });
    if (url.includes("/attachments?")) return respond({ value: [] });
    assert.ok(url.startsWith(`${base}/mailFolders/${encoded}/messages/message-one?`));
    return respond(details);
  };
  const page = await fetchMailboxPage(input(), transport);
  assert.equal(page.messages[0].bodyText, "synthetic body");
  assert.ok(calls.some(url => url.startsWith(`${base}/mailFolders/${encoded}/messages/message-one/attachments?`)));
  assert.equal(page.nextCursor, null);
});

test("a bounded manual read skips old listing results before requesting bodies on every page", async () => {
  const start = "2026-11-25T12:00:00.000Z";
  const old = "2026-11-25T11:59:59.999Z";
  const nextPage = `${base}/mailFolders/${encoded}/messages?opaque=%2B%2F`;
  for (const cursor of [null, nextPage]) {
    const calls: string[] = [];
    const page = await fetchMailboxPage({ ...input(cursor), importStart: Date.parse(start) }, async url => {
      calls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      if (calls.length === 2) {
        if (cursor) assert.equal(url, cursor);
        else {
          const { searchParams } = new URL(url);
          assert.equal(searchParams.get("$filter"), `receivedDateTime ge ${start}`);
          assert.equal(searchParams.get("$select"), "id,receivedDateTime");
        }
        return respond({ value: [{ id: "old-private-message", receivedDateTime: old }, { id: "message-one", receivedDateTime: start }] });
      }
      assert.ok(url.startsWith(`${base}/mailFolders/${encoded}/messages/message-one?`));
      return respond({ ...details, hasAttachments: false });
    });
    assert.deepEqual(page.messages.map(message => message.providerId), ["message-one"]);
    assert.equal(calls.length, 3);
  }
});

test("a stale bounded detail is rejected before attachment access", async () => {
  const start = "2026-11-25T12:00:00.000Z";
  const calls: string[] = [];
  await assert.rejects(fetchMailboxPage({ ...input(), importStart: Date.parse(start) }, async url => {
    calls.push(url);
    if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
    if (calls.length === 2) return respond({ value: [{ id: "message-one", receivedDateTime: start }] });
    return respond({ ...details, receivedDateTime: "2026-11-25T11:59:59.999Z" });
  }), { code: "MAIL_MICROSOFT_DETAIL_CHANGED" });
  assert.equal(calls.length, 3);
});

test("a moved message, invalid folder, wrong detail ID or 404 fails the page before attachment fetch", async () => {
  for (const change of [{ parentFolderId: "other" }, { parentFolderId: inbox.toLowerCase() }, { parentFolderId: null }, { id: "wrong" }, { status: 404 }]) {
    const calls: string[] = [];
    await assert.rejects(fetchMailboxPage(input(), async url => {
      calls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      if (url.startsWith(`${base}/mailFolders/inbox/messages?`)) return respond({ value: [{ id: "message-one" }] });
      if ("status" in change) return respond({}, change.status);
      return respond({ ...details, ...change });
    }));
    assert.equal(calls.length, 3);
    assert.ok(!calls.some(url => url.includes("/attachments?")));
  }
});

test("a failed detail cannot leave another chain issuing provider requests after rejection", async () => {
  const calls: string[] = [];
  await assert.rejects(fetchMailboxPage(input(), async url => {
    calls.push(url);
    if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
    if (url.startsWith(`${base}/mailFolders/inbox/messages?`)) return respond({ value: [{ id: "bad" }, { id: "good" }] });
    if (url.includes("/messages/bad?")) return respond({ ...details, id: "bad", parentFolderId: "other" });
    if (url.includes("/messages/good?")) { await new Promise(resolve => setTimeout(resolve, 30)); return respond({ ...details, id: "good" }); }
    return respond({ value: [] });
  }), /MAIL_INVALID_FOLDER_ID/);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls.length, 3);
  assert.ok(!calls.some(url => url.includes("/messages/good") || url.includes("/attachments?")));
});

test("missing Inbox identity fails before list or detail requests", async () => {
  let calls = 0;
  await assert.rejects(fetchMailboxPage(input(), async () => { calls++; return respond({}); }), /MAIL_INVALID_FOLDER_ID/);
  assert.equal(calls, 1);
});

test("dot-segment folder or message identifiers cannot escape the folder-scoped path", async () => {
  for (const id of [".", ".."]) {
    let calls = 0;
    await assert.rejects(fetchMailboxPage(input(), async () => { calls++; return respond({ id }); }), /MAIL_INVALID_FOLDER_ID/);
    assert.equal(calls, 1);
    const urls: string[] = [];
    await assert.rejects(fetchMailboxPage(input(), async url => {
      urls.push(url);
      if (url === `${base}/mailFolders/inbox?$select=id`) return respond({ id: inbox });
      return respond({ value: [{ id }] });
    }), /MAIL_INVALID_MESSAGE/);
    assert.equal(urls.length, 2);
  }
});

test("Google cursor rules remain separate", () => {
  assert.equal(mailboxCursor("google", "ABC_123=-"), "ABC_123=-");
  assert.throws(() => mailboxCursor("google", "https://graph.microsoft.com/"));
});
