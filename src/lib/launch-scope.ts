export const launchScopeDecisions = {
  internalOnly: "INTERNAL-ONLY",
  off: "LAUNCH-OFF",
  on: "LAUNCH-ON",
} as const;

export type LaunchScopeDecision =
  (typeof launchScopeDecisions)[keyof typeof launchScopeDecisions];

export const launchScopePolicyVersion = "2026-08-22.11";

/**
 * This is the enforceable technical candidate. It deliberately does not claim
 * the Product/Engineering/Security/Operations signatures that are still
 * required by the release process.
 */
export const launchScopePolicyApproval = "PENDING_SIGNATURE" as const;

type LaunchScopeActor = {
  productPermissions?: readonly string[];
  productRole?: string | null;
};

type LaunchScopeRule = Readonly<{
  allowedProductRoles?: readonly string[];
  decision: LaunchScopeDecision;
  reason: string;
  requiredProductPermissions?: readonly string[];
}>;

const internalProductRoles = Object.freeze(["platform_admin", "novalureAdmin"]);

/**
 * A checked-in, immutable policy is the single source of truth for every
 * launch-sensitive surface. There is intentionally no environment-variable
 * override: a missing or misspelled surface must stay closed in every runtime.
 */
export const launchScopePolicy = Object.freeze({
  accountAccessInvitationEmail: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Workspace invitation email requires approved Resend targets, sender-domain acceptance and signed account-access operations approval.",
  }),
  accountAccessPasswordResetEmail: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Password-reset email requires approved Resend targets, sender-domain acceptance and signed account-recovery operations approval.",
  }),
  authenticatedBotModelProvider: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Authenticated Bot model execution requires signed Product, Security and Operations approval plus an approved provider target and abuse controls.",
  }),
  botChannelInboundProcessing: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Inbound Bot channel processing, LLM execution and CRM mutation require signed Security, Product and Operations approval plus provider abuse acceptance.",
  }),
  calendarProviderMutation: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Google and Microsoft calendar provider mutations require an approved QA target and provider acceptance.",
  }),
  calendarProviderRead: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Google and Microsoft calendar availability reads require approved QA provider accounts, token handling and provider acceptance.",
  }),
  customerCommunicationProviderMutation: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Customer-facing meeting, bot, document and QA provider delivery requires signed Product and Operations scope plus approved isolated provider targets. Transactional account access email is a separate contract.",
  }),
  externalEmbeddingProvider: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "External embedding requests require signed Product, Security and Operations approval plus an approved provider target and data-processing acceptance.",
  }),
  funnelWebhookDelivery: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Durable delivery, SSRF controls, retry, audit and provider acceptance are not approved.",
  }),
  funnelPublishTokenInternalCutover: Object.freeze({
    allowedProductRoles: Object.freeze(["platform_admin"]),
    decision: launchScopeDecisions.internalOnly,
    reason: "Publish-token cutover is restricted to the internal platform-admin release procedure until the customer rotation surface is signed.",
    requiredProductPermissions: Object.freeze(["novalure:internal", "funnels:publish"]),
  }),
  funnelPublishTokenRotation: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Customer-facing publish-token rotation requires the signed launch policy and approved recovery UX.",
  }),
  importReview: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "The import contract, validation, rollback and tenant E2E are not approved.",
  }),
  newsletterDelivery: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Provider, sender domain, replay safety and allowlisted QA delivery are not approved.",
  }),
  mediaBlobMutation: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "Tenant-scoped runtime media and Blob mutations are a technical candidate for Preview validation; Production remains closed until the launch policy is signed.",
  }),
  propertyExportQueue: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Property export enqueueing remains unavailable until a durable consumer, retry contract, monitoring and Product approval exist.",
  }),
  propertyReservationRelationshipSync: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Unit status, buyer ownership and deal-stage synchronization require a signed business decision.",
  }),
  publicBookingCreation: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Booking persistence and provider mutations do not yet have an approved durable saga.",
  }),
  publicBookingLifecycle: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Public cancellation and rescheduling do not yet have an approved durable saga.",
  }),
  publicFormAdvancedConsent: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Only the audited privacy-consent contract is approved for public submission.",
  }),
  publicFormCustomPattern: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Custom public validation patterns are not approved for the launch runtime.",
  }),
  publicFormFileUpload: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Durable isolated file storage and malware scanning are not approved.",
  }),
  publicFormProofRefresh: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "Scope-bound proof refresh preserves the original idempotency key and performs no external effect.",
  }),
  publicFormRoundRobin: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Public round-robin ownership and fallback semantics are not approved.",
  }),
  publicFormSubmission: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "The fixed-owner, no-file, audited consent contract is the supported public form path.",
  }),
  publicFunnelPublication: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "Token-gated publication with strict preflight, redacted DTOs and revision-bound proofs is the supported public funnel path.",
  }),
  publicFunnelProofRefresh: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "Funnel-specific proof refresh remains bound to the current tenant, Funnel and publication revision and preserves the original idempotency key.",
  }),
  publicFunnelSubmission: Object.freeze({
    decision: launchScopeDecisions.on,
    reason: "The active, persisted, token-gated and revision-bound public funnel submission contract is approved in the technical candidate.",
  }),
  publicFunnelVisit: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "One shared consent cohort for the visit denominator and lead numerator, an independently scheduled and monitored deletion job after the 90-day eligibility point, and Product/Legal approval require signatures before activation.",
  }),
  qaReset: Object.freeze({
    allowedProductRoles: Object.freeze(["platform_admin"]),
    decision: launchScopeDecisions.internalOnly,
    reason: "QA cleanup is restricted to the internal platform-admin safety contract.",
    requiredProductPermissions: Object.freeze(["novalure:internal", "settings:manage"]),
  }),
  qaBatchRegistration: Object.freeze({
    allowedProductRoles: Object.freeze(["platform_admin"]),
    decision: launchScopeDecisions.internalOnly,
    reason: "Atomic QA batch registration is restricted to isolated Preview QA tenants.",
    requiredProductPermissions: Object.freeze(["novalure:internal", "settings:manage"]),
  }),
  qaBatchMutation: Object.freeze({
    allowedProductRoles: Object.freeze(["customer_owner", "workspace_admin", "team_member"]),
    decision: launchScopeDecisions.internalOnly,
    reason: "QA-labelled CRM mutations are restricted to the isolated two-tenant Preview matrix.",
  }),
  systemDatabaseDiagnostics: Object.freeze({
    allowedProductRoles: internalProductRoles,
    decision: launchScopeDecisions.internalOnly,
    reason: "Database and migration diagnostics are an internal operations surface.",
    requiredProductPermissions: Object.freeze(["novalure:internal"]),
  }),
  googleNotificationDelivery: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Google Chat notification delivery, queueing and retry require an approved provider target and signed Operations acceptance.",
  }),
  teamsNotificationDelivery: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "Microsoft Teams notification delivery, queueing and retry require an approved provider target and signed Operations acceptance.",
  }),
} satisfies Record<string, LaunchScopeRule>);

export type LaunchScopeSurface = keyof typeof launchScopePolicy;

const unknownLaunchScopeRule: LaunchScopeRule = Object.freeze({
  decision: launchScopeDecisions.off,
  reason: "The surface is absent from the versioned launch-scope policy.",
});

export function getLaunchScopeRule(surface: string): LaunchScopeRule {
  if (!Object.hasOwn(launchScopePolicy, surface)) return unknownLaunchScopeRule;
  return launchScopePolicy[surface as LaunchScopeSurface];
}

export function evaluateLaunchScope(
  surface: string,
  actor?: LaunchScopeActor | null,
):
  | { allowed: true; decision: LaunchScopeDecision; rule: LaunchScopeRule }
  | {
      allowed: false;
      code:
        | "LAUNCH_SCOPE_INTERNAL_ONLY"
        | "LAUNCH_SCOPE_OFF"
        | "LAUNCH_SCOPE_RUNTIME_UNSAFE"
        | "LAUNCH_SCOPE_UNKNOWN"
        | "LAUNCH_SCOPE_UNSIGNED";
      decision: LaunchScopeDecision;
      rule: LaunchScopeRule;
    } {
  const knownSurface = Object.hasOwn(launchScopePolicy, surface);
  const rule = getLaunchScopeRule(surface);

  if (!knownSurface) {
    return {
      allowed: false,
      code: "LAUNCH_SCOPE_UNKNOWN",
      decision: launchScopeDecisions.off,
      rule,
    };
  }
  if (rule.decision === launchScopeDecisions.off) {
    return {
      allowed: false,
      code: "LAUNCH_SCOPE_OFF",
      decision: rule.decision,
      rule,
    };
  }
  const vercelEnvironment = process.env.VERCEL_ENV?.trim().toLowerCase() ?? "";
  const ambiguousVercelRuntime =
    process.env.VERCEL === "1" &&
    vercelEnvironment !== "production" &&
    vercelEnvironment !== "preview" &&
    vercelEnvironment !== "development";
  if (ambiguousVercelRuntime) {
    return {
      allowed: false,
      code: "LAUNCH_SCOPE_RUNTIME_UNSAFE",
      decision: rule.decision,
      rule,
    };
  }
  if (vercelEnvironment === "production" && String(launchScopePolicyApproval) !== "SIGNED") {
    return {
      allowed: false,
      code: "LAUNCH_SCOPE_UNSIGNED",
      decision: rule.decision,
      rule,
    };
  }
  if (rule.decision === launchScopeDecisions.on) {
    return { allowed: true, decision: rule.decision, rule };
  }

  const productRoleAllowed =
    Boolean(actor?.productRole) &&
    (!rule.allowedProductRoles?.length || rule.allowedProductRoles.includes(actor?.productRole ?? ""));
  const actorPermissions = new Set(actor?.productPermissions ?? []);
  const permissionsAllowed =
    !rule.requiredProductPermissions?.length ||
    rule.requiredProductPermissions.every((permission) => actorPermissions.has(permission));

  if (productRoleAllowed && permissionsAllowed) {
    return { allowed: true, decision: rule.decision, rule };
  }

  return {
    allowed: false,
    code: "LAUNCH_SCOPE_INTERNAL_ONLY",
    decision: rule.decision,
    rule,
  };
}

export function isLaunchSurfaceEnabled(surface: LaunchScopeSurface) {
  return evaluateLaunchScope(surface).allowed;
}
