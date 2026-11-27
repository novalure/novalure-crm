import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMicrosoftMailboxCheckpoint, emptyMailboxCheckpoint, mailboxDeltaContinuationUrl, mailboxDeltaUrl } from "../src/lib/crm-mailbox-sync";
import { fetchMailboxInboxId, fetchMailboxSyncPage } from "../src/lib/integrations/mailbox-sync-provider";
import type { MailboxTransport } from "../src/lib/integrations/mailbox-provider";

const root = "https://graph.microsoft.com/v1.0/me";
const inbox = "AQMkInbox-SYNTHETIC_123==";
const alias = `${root}/mailFolders/inbox/messages/delta?$skiptoken=synthetic`;
const path = `${root}/mailFolders/${encodeURIComponent(inbox)}/messages/delta?$skiptoken=synthetic`;
const odata = `${root}/mailFolders('${inbox}')/messages/delta?$deltatoken=synthetic`;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("Graph inbox delta accepts documented path and OData forms only for the current inbox", () => {
  assert.equal(mailboxDeltaUrl(alias), alias);
  assert.equal(mailboxDeltaUrl(path, inbox), path);
  assert.equal(mailboxDeltaUrl(odata, inbox), odata);
  const quoted = odata.replaceAll("'", "%27");
  assert.equal(mailboxDeltaUrl(quoted, inbox), quoted);
  const slashId = "AQMkSYNTHETIC/a+b==";
  const encodedSlash = `${root}/mailFolders/${encodeURIComponent(slashId)}/messages/delta?$deltatoken=x`;
  assert.equal(mailboxDeltaUrl(encodedSlash, slashId), encodedSlash);
  for (const value of [path, odata, quoted, encodedSlash]) assert.throws(() => mailboxDeltaUrl(value), /MAIL_INVALID_DELTA_CURSOR/);
  for (const value of [path, odata, quoted]) assert.throws(() => mailboxDeltaUrl(value, "another-folder"), /MAIL_INVALID_DELTA_CURSOR/);
});

test("Graph delta rejects non-inbox and hostile destinations before transport", () => {
  const rejected = [
    `https://attacker.invalid/v1.0/me/mailFolders/${inbox}/messages/delta`,
    `http://graph.microsoft.com/v1.0/me/mailFolders/${inbox}/messages/delta`,
    `https://graph.microsoft.com.evil.invalid/v1.0/me/mailFolders/${inbox}/messages/delta`,
    `https://evil@graph.microsoft.com/v1.0/me/mailFolders/${inbox}/messages/delta`,
    `https://graph.microsoft.com:444/v1.0/me/mailFolders/${inbox}/messages/delta`,
    `https://graph.microsoft.com/v1.0/users/other/mailFolders/${inbox}/messages/delta`,
    `https://graph.microsoft.com/beta/me/mailFolders/${inbox}/messages/delta`,
    `${root}/mailFolders/sentitems/messages/delta`,
    `${root}/mailFolders('other')/messages/delta`,
    `${root}/mailFolders('${inbox}')/messages/delta#fragment`,
    `${root}/mailFolders('%E0%A4%A')/messages/delta`,
    `${root}/mailFolders('${inbox}')/messages/delta?$skiptoken=x\n`,
  ];
  for (const value of rejected) assert.throws(() => mailboxDeltaUrl(value, inbox), /MAIL_INVALID_DELTA_CURSOR/);
  assert.throws(() => mailboxDeltaUrl("not a URL", inbox), /MAIL_INVALID_DELTA_CURSOR/);
});

test("sync follows Graph's folder-id continuation bound to the same token's inbox", async () => {
  const token = "SYNTHETIC-TOKEN", calls: string[] = [];
  const transport: MailboxTransport = async (url, init) => {
    calls.push(url);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
    if (url === `${root}/mailFolders/inbox?$select=id`) return response({ id: inbox });
    assert.equal(new Headers(init.headers).get("prefer"), 'IdType="ImmutableId", odata.maxpagesize=5');
    if (url.startsWith(`${root}/mailFolders/inbox/messages/delta`)) return response({ value: [], "@odata.nextLink": path });
    if (url === path) return response({ value: [], "@odata.deltaLink": odata });
    throw new Error("Unexpected provider request");
  };
  const actualInbox = await fetchMailboxInboxId(token, transport);
  const first = await fetchMailboxSyncPage("microsoft", token, emptyMailboxCheckpoint(), transport, actualInbox);
  assert.equal(first.after.pendingCursor, path);
  const second = await fetchMailboxSyncPage("microsoft", token, { ...first.after, queued: [], afterQueue: null }, transport, actualInbox);
  assert.equal(second.after.deltaCheckpoint, odata);
  assert.equal(second.after.phase, "ready");
  assert.equal(calls.length, 3);
});

test("the production pilot requests one item without truncating a returned page or rewriting its cursors", async () => {
  const requested: string[] = [];
  const options = { productionPilot: true };
  const transport: MailboxTransport = async (url, init) => {
    requested.push(url);
    assert.equal(new Headers(init.headers).get("prefer"), 'IdType="ImmutableId", odata.maxpagesize=1');
    if (url === path) return response({ value: [{ id: "continued-message" }], "@odata.deltaLink": odata });
    if (url === odata) return response({ value: [], "@odata.deltaLink": odata });
    assert.equal(new URL(url).searchParams.get("$top"), "1");
    return response({ value: [{ id: "first-message" }, { id: "second-message" }], "@odata.nextLink": path });
  };
  const first = await fetchMailboxSyncPage("microsoft", "SYNTHETIC", emptyMailboxCheckpoint(), transport, inbox, null, options);
  assert.deepEqual(first.changes, [{ id: "first-message" }, { id: "second-message" }]);
  assert.equal(first.after.pendingCursor, path);
  const second = await fetchMailboxSyncPage("microsoft", "SYNTHETIC", { ...first.after, queued: [], afterQueue: null }, transport, inbox, null, options);
  assert.deepEqual(second.changes, [{ id: "continued-message" }]);
  assert.equal(second.after.deltaCheckpoint, odata);
  await fetchMailboxSyncPage("microsoft", "SYNTHETIC", { ...second.after, queued: [], afterQueue: null }, transport, inbox, null, options);
  assert.deepEqual(requested.slice(1), [path, odata]);
});

test("bounded Outlook delta requests minimal fields and discards dated old events across pages", async () => {
  const start = "2026-11-25T12:00:00.000Z";
  const old = { id: "older-message", receivedDateTime: "2026-11-25T11:59:59.999Z" };
  const current = { id: "current-message", receivedDateTime: start };
  const calls: string[] = [];
  const transport: MailboxTransport = async url => {
    calls.push(url);
    if (url === path) return response({ value: [old, current], "@odata.deltaLink": odata });
    const { searchParams } = new URL(url);
    assert.equal(searchParams.get("$filter"), `receivedDateTime ge ${start}`);
    assert.equal(searchParams.get("$select"), "id,receivedDateTime");
    return response({ value: [old, { id: "unclassified-removal", "@removed": { reason: "deleted" } }], "@odata.nextLink": path });
  };
  const first = await fetchMailboxSyncPage("microsoft", "SYNTHETIC", emptyMailboxCheckpoint(), transport, inbox, Date.parse(start));
  assert.deepEqual(first.changes, [{ id: "unclassified-removal", removed: true }]);
  const second = await fetchMailboxSyncPage("microsoft", "SYNTHETIC", { ...first.after, queued: [], afterQueue: null }, transport, inbox, Date.parse(start));
  assert.deepEqual(second.changes, [{ id: "current-message" }]);
  assert.equal(calls[1], path, "the returned continuation remains opaque");
});

test("wrong-folder cursors and provider continuations cannot be used or persisted", async () => {
  let requests = 0;
  const other = `${root}/mailFolders/other/messages/delta?$skiptoken=x`;
  const maliciousCheckpoint = { ...emptyMailboxCheckpoint(), pendingCursor: other };
  await assert.rejects(fetchMailboxSyncPage("microsoft", "SYNTHETIC", maliciousCheckpoint, async () => { requests++; return response({}); }, inbox), /MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  assert.equal(requests, 0);
  await assert.rejects(fetchMailboxSyncPage("microsoft", "SYNTHETIC", emptyMailboxCheckpoint(), async () => { requests++; return response({ value: [], "@odata.nextLink": other }); }, inbox), /MAIL_INVALID_DELTA_CURSOR/);
  assert.equal(requests, 1);
});

test("continuations require one nonempty state token without changing the opaque URL", () => {
  const base = `${root}/mailFolders/inbox/messages/delta`;
  const valid = [
    `${base}?$skiptoken=a%2Bb%3D&opaque=other`,
    `${base}?%24SkipToken=opaque%2Fvalue`,
    `${base}?skiptoken=synthetic`,
    `${base}?$deltatoken=synthetic`,
  ];
  for (const value of valid) assert.equal(mailboxDeltaContinuationUrl(value, inbox, "delta"), value);
  for (const value of valid.slice(0, 3)) assert.equal(mailboxDeltaContinuationUrl(value, inbox, "next"), value);
  for (const value of [base, `${base}?$select=id`, `${base}?$skiptoken=`, `${base}?$deltatoken=`,
    `${base}?$skiptoken=a&$skiptoken=b`, `${base}?$skiptoken=a&$deltatoken=b`, `${base}?$skiptoken=a&%24SKIPTOKEN=b`]) {
    assert.throws(() => mailboxDeltaContinuationUrl(value, inbox, "delta"), /MAIL_INVALID_DELTA_CURSOR/);
  }
  assert.throws(() => mailboxDeltaContinuationUrl(`${base}?$deltatoken=synthetic`, inbox, "next"), /MAIL_INVALID_DELTA_CURSOR/);
});

test("tokenless and wrong-kind continuations cannot trigger or complete a sync", async () => {
  const base = `${root}/mailFolders/inbox/messages/delta`;
  let calls = 0;
  const transport: MailboxTransport = async () => { calls++; return response({ value: [], "@odata.deltaLink": odata }); };
  for (const cursor of ["", base, `${base}?$skiptoken=`, `${base}?$deltatoken=wrong-kind`]) {
    const checkpoint = { ...emptyMailboxCheckpoint(), pendingCursor: cursor };
    await assert.rejects(fetchMailboxSyncPage("microsoft", "SYNTHETIC", checkpoint, transport, inbox), /MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  }
  assert.equal(calls, 0);
  for (const page of [
    { value: [], "@odata.nextLink": base },
    { value: [], "@odata.nextLink": `${base}?$deltatoken=wrong-kind` },
    { value: [], "@odata.deltaLink": base },
    { value: [], "@odata.deltaLink": `${base}?$skiptoken=` },
  ]) {
    const checkpoint = emptyMailboxCheckpoint(), before = structuredClone(checkpoint);
    await assert.rejects(fetchMailboxSyncPage("microsoft", "SYNTHETIC", checkpoint, async () => response(page), inbox), /MAIL_INVALID_DELTA_CURSOR/);
    assert.deepEqual(checkpoint, before);
  }
  // Microsoft has published a message deltaLink carrying skiptoken; accept it
  // without rewriting its opaque token or interpreting its contents.
  const documentedAlternative = `${base}?$skiptoken=synthetic`;
  const page = await fetchMailboxSyncPage("microsoft", "SYNTHETIC", emptyMailboxCheckpoint(), async () => response({ value: [], "@odata.deltaLink": documentedAlternative }), inbox);
  assert.equal(page.after.deltaCheckpoint, documentedAlternative);
});

test("Microsoft checkpoint validation preserves legitimate phase and queued-page states", () => {
  const initial=emptyMailboxCheckpoint();
  const bootstrap={...initial,pendingCursor:path};
  const history={...initial,phase:"history" as const,pendingCursor:path,deltaCheckpoint:odata};
  const ready={...initial,phase:"ready" as const,deltaCheckpoint:odata};
  for(const state of [initial,bootstrap,history,ready,
    {...initial,queued:[{id:"manual"}],afterQueue:initial},
    {...initial,queued:[{id:"from-page"}],afterQueue:bootstrap},
    {...initial,queued:[{id:"from-page"}],afterQueue:ready},
    {...ready,queued:[{id:"manual"}],afterQueue:ready},
    {...history,queued:[{id:"removed",removed:true}],afterQueue:ready}]) {
    assert.doesNotThrow(()=>assertMicrosoftMailboxCheckpoint(state,inbox));
  }
});

test("inconsistent Microsoft checkpoint phases and queued pages require review without provider I/O", async () => {
  const initial=emptyMailboxCheckpoint();
  const history={...initial,phase:"history" as const,pendingCursor:path,deltaCheckpoint:odata};
  const bad:unknown[] = [
    {...initial,phase:"ready"}, {...initial,phase:"history"},
    {...initial,phase:"history",pendingCursor:path}, {...initial,phase:"history",deltaCheckpoint:odata},
    {...initial,phase:"ready",pendingCursor:path,deltaCheckpoint:odata},
    {...initial,phase:"bootstrap",deltaCheckpoint:odata},
    {...initial,phase:"unknown"}, {...initial,pendingCursor:""}, {...initial,deltaCheckpoint:7},
    {...initial,phase:"ready",deltaCheckpoint:odata,anchor:"google-history"},
    {...initial,queued:[{id:"pending"}],afterQueue:null},
    {...initial,queued:[],afterQueue:history},
    {...initial,queued:[{id:"pending"}],afterQueue:{...initial,phase:"ready"}},
    {...initial,queued:[{id:"pending"}],afterQueue:{...initial,pendingCursor:`${root}/mailFolders/other/messages/delta?$skiptoken=x`}},
    {...initial,queued:[{id:""}],afterQueue:initial}, {...initial,queued:"not-an-array"}, null,
  ];
  for(const state of bad)assert.throws(()=>assertMicrosoftMailboxCheckpoint(state,inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  for(const state of bad.slice(0,7)) {
    let calls=0;
    await assert.rejects(fetchMailboxSyncPage("microsoft","SYNTHETIC",state as ReturnType<typeof emptyMailboxCheckpoint>,async()=>{calls++;return response({});},inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
    assert.equal(calls,0);
  }
  const queued={...initial,queued:[{id:"pending"}],afterQueue:history};let calls=0;
  await assert.rejects(fetchMailboxSyncPage("microsoft","SYNTHETIC",queued,async()=>{calls++;return response({});},inbox),/MAIL_CHECKPOINT_REVIEW_REQUIRED/);
  assert.equal(calls,0);
});

test("malformed Graph delta pages cannot produce a checkpoint or mutate the prior state", async () => {
  const checkpoint = { ...emptyMailboxCheckpoint(), phase: "history" as const, pendingCursor: path, deltaCheckpoint: odata };
  const before = structuredClone(checkpoint);
  const badPages: unknown[] = [
    { "@odata.deltaLink": odata },
    { value: null, "@odata.deltaLink": odata },
    { value: {}, "@odata.deltaLink": odata },
    { value: [] },
    { value: [], "@odata.nextLink": path, "@odata.deltaLink": odata },
    { value: [], "@odata.nextLink": null, "@odata.deltaLink": odata },
    { value: [], "@odata.nextLink": "" },
    { value: [], "@odata.nextLink": 12 },
    { value: [], "@odata.deltaLink": null },
    { value: [], "@odata.deltaLink": `${root}/mailFolders/sentitems/messages/delta` },
    { value: Array.from({ length: 501 }, (_, i) => ({ id: `SYNTHETIC-${i}` })), "@odata.deltaLink": odata },
    { value: [{ subject: "no provider ID" }], "@odata.deltaLink": odata },
  ];
  for (const page of badPages) {
    let calls = 0;
    await assert.rejects(fetchMailboxSyncPage("microsoft", "SYNTHETIC", checkpoint, async () => { calls++; return response(page); }, inbox));
    assert.equal(calls, 1);
    assert.deepEqual(checkpoint, before);
  }
});
