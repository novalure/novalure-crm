import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Synthetic route boundary: no real cookie, database or suppression service.
const url = (path: string) => pathToFileURL(resolve(process.cwd(), path)).href;
let calls = 0;
const rejectCall = async () => { calls++; throw new Error("unexpected repository call"); };
mock.module(url("src/lib/auth/session.ts"), { namedExports: {
  resolveWorkspaceScopedSession: async () => ({ ok: true, session: { workspaceId: "synthetic" } }),
} });
mock.module(url("src/lib/db/crm-mailbox-repository.ts"), { namedExports: {
  associateCrmMailboxMessage: rejectCall, disconnectCrmMailbox: rejectCall,
  eraseCrmMailboxCopy: rejectCall, loadCrmMailbox: rejectCall, syncCrmMailbox: rejectCall,
} });
mock.module(url("src/lib/db/crm-mailbox-sync-repository.ts"), { namedExports: {
  actOnMailboxPrivateDecision: rejectCall, loadContactMailboxReview: rejectCall,
  runPersonalMailboxSync: rejectCall, saveMailboxAutoSettings: rejectCall,
} });
let post: typeof import("../src/app/api/crm/mailbox/route").POST;
before(async () => { ({POST: post} = await import("../src/app/api/crm/mailbox/route")); });

test("read pilot rejects an attempted suppression action before any repository access", async () => {
  calls = 0;
  const response = await post(new Request("https://crm.example.invalid/api/crm/mailbox", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({action: "suppress_reviewed_address"}),
  }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});
