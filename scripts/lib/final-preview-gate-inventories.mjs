const tenants = Object.freeze(["a", "b"]);
const actors = Object.freeze(["owner", "admin", "member", "customer"]);

const twoTenantDatabaseSuffixes = Object.freeze([
  "db.app_role",
  "db.tenant_role_inherited",
  "db.qa_batches_rls_active",
  "db.qa_batch_objects_rls_active",
  "db.ledger_base_denied",
  "db.ledger_projection_read_only",
  "db.ledger_projection_owner_scoped",
  "db.ledger_projection_columns_exact",
  "db.ledger_projection_public_denied",
  "db.workspace_is_qa",
  "db.project_scope",
  "db.batch_exists",
  "db.batch_marker",
  "db.batch_actor",
  "db.batch_unused",
  "db.active_sessions_before_login",
  "db.marker_unused",
  ...actors.map((actor) => `db.actor.${actor}`),
  "db.reset_actor",
  "db.migrations_launch_required",
  "db.migrations_launch_required_checksummed",
  "db.launch_schema_artifacts_075_076",
  "db.tenant_constraints_present",
  "db.tenant_constraints_validated",
  "db.tenant_constraints_deferrable",
  "db.tenant_relation_preflight_count",
  "db.tenant_relation_preflight_zero",
  "db.tenant_relation_gate",
]);

const twoTenantHttpPreflightSuffixes = Object.freeze([
  ...actors.map((actor) => `auth.${actor}`),
  "auth.reset_admin",
  ...actors.map((actor) => `cross_tenant.${actor}.read`),
  "public.api_read",
  "public.page",
  "public.no_cross_tenant_id",
  "batch.runtime_capability",
]);

const twoTenantBusinessSuffixes = Object.freeze([
  ...["owner", "admin", "member"].flatMap((actor) => [
    `contact.${actor}.create`,
    `contact.${actor}.payload_scope`,
  ]),
  "contact.customer.create",
  "contact.public.create",
  "contact.customer.read",
  "contact.public.read",
  ...["owner", "admin", "member"].flatMap((actor) => [
    `contact.${actor}.read`,
    `contact.${actor}.update`,
  ]),
  "deal.pipeline_stages",
  ...["owner", "admin", "member"].map((actor) => `deal.${actor}.create`),
  "deal.concurrency",
  "deal.idempotency",
  "deal.owner.update",
  "persistence.relogin",
  ...actors.map((actor) => `cross_tenant.${actor}.update`),
  "contact.customer.update",
  "contact.public.update",
  "contact.member.delete",
  "contact.customer.delete",
  "contact.public.delete",
  "contact.owner.delete",
  "contact.admin.delete",
]);

const twoTenantCleanupSuffixes = Object.freeze([
  "cleanup.dry_run",
  "cleanup.execute",
  "cleanup.remaining_rows",
]);

export const twoTenantExpectedResultIds = Object.freeze([
  "runtime.identity.pre_auth",
  ...tenants.flatMap((tenant) => [
    ...twoTenantDatabaseSuffixes.map((suffix) => `${tenant}.${suffix}`),
    ...twoTenantHttpPreflightSuffixes.map((suffix) => `${tenant}.${suffix}`),
    ...twoTenantBusinessSuffixes.map((suffix) => `${tenant}.${suffix}`),
    ...twoTenantCleanupSuffixes.map((suffix) => `${tenant}.${suffix}`),
  ]),
  ...Array.from({ length: 12 }, (_, index) => `auth.logout.${index}`),
]);

export const twoTenantCleanupResourceTypes = Object.freeze([
  "consent_records",
  "contacts",
  "deal_stage_history",
  "deals",
  "marker_consent_records",
  "marker_contacts",
  "marker_deal_stage_history",
  "marker_deals",
]);

export const previewBlobExpectedCheckIds = Object.freeze([
  "auth.session_exact_scope",
  "deployment.capability_available",
  "deployment.origin_host_exact",
  "deployment.id_exact",
  "deployment.database_branch_exact",
  "deployment.git_sha_exact",
  "deployment.git_branch_exact",
  "list.marker_absent_before",
  "upload.http_created",
  "upload.private_contract",
  "list.private_asset_once",
  "store.list_one_new_private_object",
  "store.head_private_object_exact",
  "read.unauthenticated_denied_without_leak",
  "read.cross_tenant_denied_without_leak",
  "list.cross_tenant_marker_absent",
  "read.private_bytes_exact",
  "read.private_headers_exact",
  "delete.list_null_rest",
  "delete.read_returns_404",
  "store.list_and_head_absent_after_delete",
]);

export const providerExpectedRequestIds = Object.freeze([
  "identity.session",
  "identity.runtime",
  "public.password-reset-request",
  "settings.invitation-email",
  "settings.invitation-email-resend",
  "settings.password-reset-email",
  "customer-access.invitation-email",
  "calendar.google-mutation",
  "calendar.microsoft-mutation",
  "oauth.google.start",
  "oauth.google.callback",
  "oauth.google.disconnect",
  "oauth.microsoft.start",
  "oauth.microsoft.callback",
  "oauth.microsoft.disconnect",
]);

export const providerExpectedDatabaseTables = Object.freeze([
  "audit_logs",
  "auth_audit_events",
  "auth_password_reset_tokens",
  "calendar_sync_events",
  "newsletter_sends",
  "oauth_authorization_states",
  "provider_connections",
  "workspace_users",
]);

export const publicExpectedReadOnlyRequestIds = Object.freeze([
  "public-form-shell-missing",
  "public-form-proof-invalid",
  "public-form-submit-missing",
  "public-funnel-shell-missing",
  "public-funnel-proof-invalid",
  "public-funnel-submit-invalid",
  "public-funnel-visit-launch-off",
]);

export const publicRequiredProofIds = Object.freeze([
  "public-form-long-proof-refresh",
  "public-form-live-submission",
  "public-funnel-long-proof-refresh",
  "public-funnel-live-submission",
  "funnel-publish-token-rotation",
]);

const languages = Object.freeze(["de", "en"]);
const a11yPublicProfiles = Object.freeze([
  ["desktop", ["/", "/login", "/login/forgot-password", "/login/reset-password", "/imprint", "/privacy", "/cookies", "/terms", "/data-deletion", "/datadeletion", "/meta"]],
  ["mobile", ["/", "/login", "/login/forgot-password", "/login/reset-password", "/imprint", "/privacy", "/cookies", "/terms", "/data-deletion", "/datadeletion", "/meta"]],
  ["zoom-200-reflow", ["/", "/login", "/login/reset-password", "/privacy", "/datadeletion"]],
  ["zoom-400-reflow", ["/", "/login", "/login/reset-password", "/privacy", "/datadeletion"]],
]);
const a11yAuthenticatedProfiles = Object.freeze([
  ["desktop", ["dashboard", "contacts", "pipelines", "tasks", "meetings", "forms", "funnels", "settings", "invitation"]],
  ["mobile", ["dashboard", "contacts", "pipelines", "tasks", "meetings", "forms", "funnels", "settings", "invitation"]],
  ["zoom-200-reflow", ["dashboard", "contacts", "tasks", "forms", "funnels", "settings", "invitation"]],
  ["zoom-400-reflow", ["dashboard", "contacts", "forms", "settings"]],
]);
const a11yFixtureRoutes = Object.freeze([
  "public-form-page",
  "public-form-submit-result",
  "public-funnel-page",
  "public-funnel-submit-result",
  "password-reset-result",
]);

function matrixKeys(surface, profiles) {
  return profiles.flatMap(([profile, routes]) => routes.flatMap((route) =>
    languages.map((language) => `${surface}|${route}|${language}|${profile}`)));
}

export const a11yExpectedResultKeys = Object.freeze([
  ...matrixKeys("public", a11yPublicProfiles),
  ...matrixKeys("public-fixture", [
    ["desktop", a11yFixtureRoutes],
    ["mobile", a11yFixtureRoutes],
    ["zoom-400-reflow", a11yFixtureRoutes],
  ]),
  ...matrixKeys("auth-fixture", [
    ["desktop", ["mfa-verification"]],
    ["mobile", ["mfa-verification"]],
    ["zoom-400-reflow", ["mfa-verification"]],
  ]),
  ...matrixKeys("authenticated", a11yAuthenticatedProfiles),
]);

const performanceRoutes = Object.freeze({
  authenticated: ["/#dashboard", "/#contacts", "/#pipelines", "/#tasks", "/#meetings"],
  public: ["/", "/login", "/privacy"],
});

export const performanceExpectedResultKeys = Object.freeze(
  Object.entries(performanceRoutes).flatMap(([surface, routes]) => routes.flatMap((route) =>
    languages.flatMap((language) => ["mobile", "desktop"].flatMap((profile) =>
      ["cold", "warm"].map((temperature) =>
        `${surface}|${route}|${language}|${profile}|${temperature}`))))),
);
