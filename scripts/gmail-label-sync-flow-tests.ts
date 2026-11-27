import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { protectMailboxToken } from "../src/lib/db/crm-mailbox-repository";
import { runPersonalMailboxSync } from "../src/lib/db/crm-mailbox-sync-repository";
import { emptyMailboxCheckpoint, mailboxSyncPosition } from "../src/lib/crm-mailbox-sync";

// Scripted pool and transport: no real DB, RLS, provider, locking or commit proof.
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-gmail-label-test-key";
const workspaceId = randomUUID(), userId = randomUUID(), identityId = randomUUID(), connectionId = randomUUID();
const messageId = "synthetic-message", accountId = "synthetic-account", label = "person@example.invalid";
const session = { authenticated: true, workspaceId, userId, authIdentityId: identityId, workspaceName: "Synthetic", email: label, name: "Synthetic", source: "database", role: "owner", productRole: "customer_owner", permissions: ["crm:read"], productPermissions: [] } as AppSession;
const synthetic = (labels: unknown) => ({ id: messageId, threadId: "synthetic-thread", internalDate: "1795608000000", labelIds: labels, payload: { mimeType: "text/plain", headers: [], body: { data: "U3ludGhldGlj" } } });

for (const mode of ["queued-metadata", "queued-content", "recovery-verify", "queued-meta-bad-fields", "queued-meta-410", "recovery-410", "queued-bad-json", "queued-large-json", "queued-content-bad-json", "queued-network-error", "queued-content-moved", "queued-content-wrong-id", "queued-content-404"] as const) test(`${mode}: uncertain Gmail observation does not consume a queued item or recovery position`, async () => {
  const ready = emptyMailboxCheckpoint();
  const recovering = mode.startsWith("recovery-");
  const checkpoint = recovering ? ready : { ...ready, queued: [{ id: messageId }], afterQueue: mailboxSyncPosition(ready) };
  const before = structuredClone(checkpoint);
  const writes: string[] = [];
  let revision = 7, policyRevision = 3, status: string | null = null;
  const key = protectMailboxToken(session, "google", "synthetic-access", label);
  const pool = { async connect() { return { release() {}, async query(sql: string, args: unknown[] = []) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from pg_roles runtime_role")) return { rows: [{ safe: true }] };
    if (["begin", "rollback", "commit"].includes(q)) return { rows: [], command: q.toUpperCase() };
    if (q.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId, actorId: userId }] };
    if (q.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: identityId }] };
    if (q.includes("to_regclass('public.crm_mailbox_auto_settings')")) return { rows: [{ ready: true }] };
    if (q.startsWith("select c.id,c.provider") && q.includes("for update of c,s")) return { rows: [{ id: connectionId, provider: "google", tenantId: null, subject: null, label, accountId, format: "legacy", access: key, refresh: null, scopes: ["https://www.googleapis.com/auth/gmail.readonly"], expiresAt: new Date(Date.now() + 3600000).toISOString(), revision, policyRevision, identityId, autoFile: false, contactReview: false, backfillReplaying: false, failures: 0, enabled: true, due: true, busy: false }] };
    if (q.startsWith("select checkpoint from crm_mailbox_auto_checkpoints")) return { rows: [{ checkpoint }] };
    if (q.startsWith("update crm_mailbox_connections c set sync_lease_id=$2")) return { rows: [{ revision: ++revision }] };
    if (q.startsWith("select to_jsonb(c)->>'provider_tenant_id'")) return { rows: [{ tenantId: null, subject: null, accountId }] };
    if (q.startsWith("select revision from crm_mailbox_connections")) return { rows: [{ revision }] };
    if (q.startsWith("update crm_mailbox_connections set provider_account_id")) { revision++; return { rows: [] }; }
    if (q.includes("to_regclass('public.crm_mailbox_cursor_recovery')")) return { rows: [{ ready: recovering }] };
    if (q.startsWith("select phase,ceiling_id")) return { rows: [{ phase: "verify", ceilingId: workspaceId, lastId: null, baseline: ready }] };
    if (q.startsWith("select id,provider_id") && q.includes("order by id limit 5")) return { rows: [{ id: workspaceId, providerId: messageId }] };
    if (q.startsWith("select m.deleted_at is not null")) return { rows: [{ deleted: false, leadId: userId, projectId: workspaceId, contactId: identityId }] };
    if (q.startsWith("select id as \"leadid\"")) return { rows: [{ leadId: userId, projectId: workspaceId, contactId: identityId }] };
    if (q.startsWith("select id from crm_mailbox_private_decisions") && q.includes("quarantined")) return { rows: [] };
    if (q.startsWith("update crm_mailbox_auto_settings set status=")) { status = String(args[1]); return { rows: [{ revision: ++policyRevision }] }; }
    if (q.startsWith("delete from crm_mailbox_private_decisions") && q.includes("status='ignored'")) return { rows: [] };
    if (q.startsWith("update crm_mailbox_connections c set sync_lease_id=null")) return { rows: [{ revision: ++revision }] };
    if (/^(insert|update|delete) /.test(q)) { writes.push(q); return { rows: [] }; }
    throw new Error(`Unexpected synthetic query: ${q}`);
  } }; } } as unknown as TenantPool;
  let messageReads = 0;
  const transport = async (url: string) => {
    if (url.includes("openidconnect.googleapis.com")) return Response.json({ email: label, email_verified: true, sub: accountId });
    if (url.includes("/messages/")) {
      messageReads++;
      if (mode === "queued-network-error") throw new Error("synthetic connection failure");
      if (mode === "queued-bad-json" || mode === "queued-content-bad-json" && messageReads === 2) return new Response("{invalid");
      if (mode === "queued-large-json") return new Response("{}", { headers: { "content-length": "1048577" } });
      if (mode === "queued-meta-bad-fields") return Response.json({ ...synthetic(undefined), id: "wrong", internalDate: "bad" });
      if (mode === "queued-meta-410" || mode === "recovery-410") return new Response("{}", { status: 410 });
      if (mode === "queued-content-404" && messageReads === 2) return new Response("{}", { status: 404 });
      if (mode === "queued-content-moved" && messageReads === 2) return Response.json(synthetic([]));
      if (mode === "queued-content-wrong-id" && messageReads === 2) return Response.json({ ...synthetic(["INBOX"]), id: "different" });
      return Response.json(synthetic(mode.startsWith("queued-content") && messageReads === 1 ? ["INBOX"] : undefined));
    }
    throw new Error(`Unexpected synthetic provider URL: ${url}`);
  };
  await assert.rejects(runPersonalMailboxSync(session, connectionId, { pool, transport, ignoreDue: true }), /MAIL_INVALID_GMAIL_LABEL_IDS|MAIL_INVALID_RESPONSE|MAIL_RESPONSE_TOO_LARGE|MAIL_PROVIDER_UNAVAILABLE|MAIL_GMAIL_DETAIL_CHANGED|MAIL_MESSAGE_ID_CHANGED|MAIL_INVALID_DATE|MAIL_CHECKPOINT_EXPIRED/);
  assert.deepEqual(checkpoint, before);
  assert.deepEqual(writes, [], "no checkpoint, decision, message, source status or recovery writes");
  assert.equal(status, "delayed");
  assert.equal(messageReads, mode.startsWith("queued-content") ? 2 : 1);
});
