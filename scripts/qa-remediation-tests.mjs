import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() + "/src" } });
const { sanitizeLocalRedirect } = await jiti.import("../src/lib/auth/redirects.ts");
const { authorizeWorkspaceAccessOperation } = await jiti.import("../src/lib/auth/access-policy.ts");
const { detectMediaMime } = await jiti.import("../src/lib/media-store.ts");

function source(path) {
  return readFileSync(path, "utf8");
}

function session(overrides = {}) {
  return {
    authenticated: true,
    email: "admin@example.invalid",
    name: "Admin",
    permissions: ["settings:manage"],
    productPermissions: ["workspace:admin"],
    productRole: "workspace_admin",
    role: "admin",
    source: "database",
    userId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000010",
    workspaceName: "Test",
    ...overrides,
  };
}

test("redirect sanitizer rejects external, encoded and authentication-loop targets", () => {
  const attacks = [
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example",
    "/%2f%2fevil.example",
    "/%252f%252fevil.example",
    "/%5cevil.example",
    "/login?returnTo=/dashboard",
    "/api/auth/logout",
    "/ok\r\nLocation:https://evil.example",
  ];
  for (const attack of attacks) assert.equal(sanitizeLocalRedirect(attack, "/safe"), "/safe", attack);
  assert.equal(sanitizeLocalRedirect("/dashboard?tab=tasks#today", "/safe"), "/dashboard?tab=tasks#today");
});

test("workspace administrators cannot reset or mutate another owner", () => {
  const actor = session();
  const owner = {
    id: "00000000-0000-4000-8000-000000000002",
    productRole: "customer_owner",
    role: "owner",
    status: "active",
    workspaceId: actor.workspaceId,
  };
  assert.equal(authorizeWorkspaceAccessOperation({ actor, operation: "password_reset", target: owner }).ok, false);
  assert.equal(authorizeWorkspaceAccessOperation({ actor, operation: "update", target: owner }).ok, false);
  assert.equal(authorizeWorkspaceAccessOperation({ actor: session({ productRole: "platform_admin" }), operation: "password_reset", target: owner }).ok, true);
  assert.equal(authorizeWorkspaceAccessOperation({ actor, operation: "password_reset", target: { ...owner, workspaceId: "00000000-0000-4000-8000-000000000099" } }).ok, false);
});

test("media detection uses file signatures and rejects disguised input", () => {
  assert.equal(detectMediaMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectMediaMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectMediaMime(new TextEncoder().encode("%PDF-1.7\n")), "application/pdf");
  assert.equal(detectMediaMime(new TextEncoder().encode("<script>alert(1)</script>")), null);
});

test("media APIs never redirect to or serialize the storage URL", () => {
  const store = source("src/lib/media-store.ts");
  const privateRoute = source("src/app/api/media/files/[assetId]/route.ts");
  const publicRoute = source("src/app/api/media/public/[token]/route.ts");
  assert.match(store, /access: "private"/);
  assert.doesNotMatch(store, /access: "public"/);
  assert.doesNotMatch(privateRoute + publicRoute, /redirect\(asset\.url\)/);
  assert.match(privateRoute + publicRoute, /readMediaAssetContent/);
  assert.match(store, /scanStatus !== "clean"/);
  assert.match(store, /NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN/);
  assert.match(store, /PRIVATE_STORAGE_NOT_CONFIGURED/);
});

test("legacy media migration verifies copy integrity and records a resumable manifest", () => {
  const migration = source("scripts/migrate-private-media.mjs");
  const schema = source("migrations/048_qa_security_and_reliability.sql");
  assert.match(migration, /Legacy size mismatch/);
  assert.match(migration, /Private checksum verification failed/);
  assert.match(migration, /Legacy-public and private Blob stores must use separate credentials/);
  assert.match(migration, /verifyLegacyDeletion/);
  assert.match(schema, /media_private_migration_manifest/);
});

test("reservation mutation is one transaction with locking, idempotency and outbox", () => {
  const reservation = source("src/lib/db/reservation-repositories.ts");
  assert.match(reservation, /withTransaction\(async \(transaction\)/);
  assert.match(reservation, /reservation_workflow_requests/);
  assert.match(reservation, /for update/);
  assert.match(reservation, /insert into teams_notification_jobs/);
  assert.match(reservation, /insert into audit_logs/);
  assert.match(reservation, /insert into analytics_events/);
});

test("cron workers use leases, skip locked, deadlines and provider timeouts", () => {
  const workers = [
    source("src/lib/db/google-notification-repositories.ts"),
    source("src/lib/db/teams-notification-repositories.ts"),
    source("src/lib/db/meeting-repositories.ts"),
  ].join("\n");
  assert.match(workers, /for update skip locked/);
  assert.match(workers, /lease_expires_at/);
  assert.match(workers, /dead_letter/);
  assert.match(workers, /AbortSignal\.timeout/);
  assert.match(workers, /Delivery lease expired after the final attempt/);
  assert.match(source("src/app/api/cron/google-alerts/route.ts"), /deadlineMs/);
});

test("contact restore is transactional, paginated and conflict-aware", () => {
  const contacts = source("src/lib/db/crm-write-repositories.ts");
  const route = source("src/app/api/crm/contacts/route.ts");
  const ui = source("src/components/contact-command-center.tsx");
  assert.match(contacts, /withTransaction\(async \(transaction\)/);
  assert.match(contacts, /contact\.restored/);
  assert.match(contacts, /contact_restored/);
  assert.match(contacts, /metadata - 'archivedByUserId' - 'archivedFrom'/);
  assert.match(route, /return 409/);
  assert.match(ui, /archivedPage/);
  assert.match(ui, /Archiviert/);
});

test("authentication uses persistent HMAC rate limits without returning raw identity data", () => {
  const rateLimit = source("src/lib/auth/rate-limit.ts");
  const login = source("src/app/api/auth/login/route.ts");
  const reset = source("src/app/api/auth/password-reset/request/route.ts");
  assert.match(rateLimit, /auth_rate_limits/);
  assert.match(rateLimit, /createHmac/);
  assert.match(login, /clearLoginAuthLimits/);
  assert.match(login, /error: "invalid_credentials"/);
  assert.doesNotMatch(reset, /searchParams\.set\("email"/);
});

test("public page proxy assigns a request id for successful and failed renders", () => {
  const proxy = source("src/proxy.ts");
  assert.match(proxy, /crypto\.randomUUID\(\)/);
  assert.match(proxy, /response\.headers\.set\("x-request-id"/);
});

test("public routing and reset responses enforce status and PII hygiene", () => {
  assert.match(source("src/app/forms/public-form-page.tsx"), /notFound\(\)/);
  assert.match(source("src/app/book/public-booking-page.tsx"), /notFound\(\)/);
  assert.match(source("src/app/forms/\[slug\]/page.tsx"), /permanentRedirect/);
  assert.match(source("src/app/api/auth/password-reset/request/route.ts"), /searchParams\.set\("sent", "1"\)/);
  assert.doesNotMatch(source("src/app/api/auth/password-reset/request/route.ts"), /searchParams\.set\("email"/);
});
