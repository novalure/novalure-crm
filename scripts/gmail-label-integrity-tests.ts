import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMailboxKnownContent, fetchMailboxMetadata } from "../src/lib/integrations/mailbox-sync-provider";
import { fetchMailboxPage, MailboxProviderError, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";

const id = "synthetic-message";
const scope = ["https://www.googleapis.com/auth/gmail.readonly"];
const message = (labelIds: unknown) => ({ id, threadId: "synthetic-thread", internalDate: "1795608000000", labelIds, payload: { mimeType: "text/plain", headers: [], body: { data: "U3ludGhldGlj" } } });
const invalid = (error: unknown) => error instanceof MailboxProviderError && error.code === "MAIL_INVALID_GMAIL_LABEL_IDS" && error.status === undefined;
const bad: unknown[] = [undefined, null, "INBOX", {}, 0, [null], ["INBOX", 7], [""], ["has space"], ["x".repeat(1025)]];

test("Gmail metadata distinguishes validated inbox, validated absence, and unknown labels", async () => {
  const read = (labels: unknown) => fetchMailboxMetadata("google", "synthetic", id, async () => Response.json(message(labels)));
  assert.equal((await read(["INBOX", "UNREAD"]))?.inInbox, true);
  assert.equal((await read([]))?.inInbox, false);
  assert.equal((await read(["SENT"]))?.inInbox, false);
  for (const labels of bad) await assert.rejects(read(labels), invalid);
  for (const overrides of [{ id: "wrong", internalDate: "bad" }, { id: null, payload: { headers: [1] } }]) {
    await assert.rejects(fetchMailboxMetadata("google", "synthetic", id, async () => Response.json({ ...message(undefined), ...overrides })), invalid);
  }
  assert.equal(await fetchMailboxMetadata("google", "synthetic", id, async () => new Response("{}", { status: 404 })), null);
});

test("Gmail full-content fetch rejects unknown labels without silently producing content", async () => {
  const read = (labels: unknown) => fetchMailboxKnownContent("google", "synthetic", id, async () => Response.json(message(labels)));
  for (const labels of bad) await assert.rejects(read(labels), invalid);
  assert.equal((await read(["INBOX"])).providerId, id);
  await assert.rejects(read([]), /MAIL_GMAIL_DETAIL_CHANGED/);
  await assert.rejects(read(["SENT"]), /MAIL_GMAIL_DETAIL_CHANGED/);
  await assert.rejects(fetchMailboxKnownContent("google", "synthetic", id, async () => Response.json({ ...message(["INBOX"]), id: "different" })), /MAIL_GMAIL_DETAIL_CHANGED/);
  for (const status of [404, 410]) await assert.rejects(fetchMailboxKnownContent("google", "synthetic", id, async () => new Response("{}", { status })), /MAIL_GMAIL_DETAIL_CHANGED/);
});

test("manual Gmail fetch rejects malformed detail labels without continuing the page", async () => {
  for (const labels of bad) {
    const requested: string[] = [];
    const transport: MailboxTransport = async (url) => {
      requested.push(url);
      return url.includes("?maxResults=") ? Response.json({ messages: [{ id }, { id: "later" }], nextPageToken: "next" }) : Response.json(message(labels));
    };
    await assert.rejects(fetchMailboxPage({ provider: "google", accessToken: "synthetic", grantedScopes: scope, cursor: null }, transport), invalid);
    assert.equal(requested.length, 2, "no later detail request is left in flight");
  }
});

test("manual Gmail fetch refuses a moved or different message after Inbox listing", async () => {
  for (const labels of [[], ["SENT"]]) {
    const transport: MailboxTransport = async (url) => url.includes("?maxResults=") ? Response.json({ messages: [{ id }] }) : Response.json(message(labels));
    await assert.rejects(fetchMailboxPage({ provider: "google", accessToken: "synthetic", grantedScopes: scope, cursor: null }, transport), /MAIL_GMAIL_DETAIL_CHANGED/);
  }
  const transport: MailboxTransport = async (url) => url.includes("?maxResults=") ? Response.json({ messages: [{ id }] }) : Response.json({ ...message(["INBOX"]), id: "different" });
  await assert.rejects(fetchMailboxPage({ provider: "google", accessToken: "synthetic", grantedScopes: scope, cursor: null }, transport), /MAIL_GMAIL_DETAIL_CHANGED/);
  const valid: MailboxTransport = async (url) => url.includes("?maxResults=") ? Response.json({ messages: [{ id }] }) : Response.json(message(["INBOX"]));
  assert.equal((await fetchMailboxPage({ provider: "google", accessToken: "synthetic", grantedScopes: scope, cursor: null }, valid)).messages[0].providerId, id);
});
