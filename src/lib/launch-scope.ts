import { readLaunchActivationChannelSnapshot } from "./launch-activation-channel.shared.mjs";
import {
  launchActivationMinimumGeneration,
  launchActivationProductionFlagsEnvironment,
} from "./launch-activation-contract.shared.mjs";

export const launchScopeDecisions = {
  internalOnly: "INTERNAL-ONLY",
  off: "LAUNCH-OFF",
  on: "LAUNCH-ON",
} as const;

export type LaunchScopeDecision =
  (typeof launchScopeDecisions)[keyof typeof launchScopeDecisions];

export const launchScopePolicyVersion = "2026-08-22.12";

/**
 * This is the enforceable technical candidate. It deliberately does not claim
 * the Product/Engineering/Security/Operations signatures that are still
 * required by the release process.
 */
export const launchScopePolicyApproval = "PENDING_SIGNATURE" as const;

/**
 * Production activation is deliberately separate from the checked-in policy
 * approval marker. The repository never changes the marker to `SIGNED` and it
 * never embeds a signer key. Instead, Operations may install the exact,
 * non-secret binding produced by the external Ed25519 receipt verifier after
 * the final deployment exists. Missing, partial or mismatched bindings fail
 * closed. None of these values can change a policy decision.
 */
export const launchScopeProductionActivationContract =
  "NOVALURE_LAUNCH_ACTIVATION_RECEIPT_V1" as const;
export const launchScopeProductionFlagsEnvironment =
  launchActivationProductionFlagsEnvironment;
export const launchScopeProductionMinimumActivationGeneration =
  launchActivationMinimumGeneration;

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
  publicSpanishLocale: Object.freeze({
    decision: launchScopeDecisions.off,
    reason: "The Spanish public product surface requires complete ES content, Legal, accessibility and Product approval before it can be offered.",
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
    allowedProductRoles: Object.freeze(["customer_owner", "platform_admin", "workspace_admin", "team_member"]),
    decision: launchScopeDecisions.internalOnly,
    reason: "QA-labelled CRM mutations are restricted to allowlisted isolated Preview tenants; platform admins are required by the protected public-runtime harness.",
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

const compareCanonicalText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const launchScopeCanonicalRules = Object.freeze(
  (Object.entries(launchScopePolicy) as [string, LaunchScopeRule][])
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([surface, rule]) => Object.freeze({
      allowedProductRoles: Object.freeze(
        [...(rule.allowedProductRoles ?? [])].sort(compareCanonicalText),
      ),
      decision: rule.decision,
      reason: rule.reason,
      requiredProductPermissions: Object.freeze(
        [...(rule.requiredProductPermissions ?? [])].sort(compareCanonicalText),
      ),
      surface,
    })),
);

/** Canonical evidence input; its SHA-256 is independently recomputed in tests. */
export const launchScopePolicyCanonicalDocument = Object.freeze({
  policyVersion: launchScopePolicyVersion,
  rules: launchScopeCanonicalRules,
  schemaVersion: 1,
});

/**
 * Decision-only evidence input. Reasons remain covered by the full policy
 * digest, while this digest pins the executable decision/role/capability map.
 */
export const launchScopeDecisionCanonicalDocument = Object.freeze({
  decisions: Object.freeze(launchScopeCanonicalRules.map((rule) => Object.freeze({
    allowedProductRoles: rule.allowedProductRoles,
    decision: rule.decision,
    requiredProductPermissions: rule.requiredProductPermissions,
    surface: rule.surface,
  }))),
  policyVersion: launchScopePolicyVersion,
  schemaVersion: 1,
});

// These values are generated from the two canonical documents above. Keeping
// them as literals makes this client-safe module independent of node:crypto.
// Contract tests recompute both digests and reject any stale literal.
export const launchScopePolicySha256 =
  "7665d0dbf0b145a0148d43f5bfde65ea1afba36eece987bcc2530b22c213618f" as const;
export const launchScopeDecisionSha256 =
  "cdb09e429e79cd661d948d2dc8a4e78cf1a0aeb21169b24db69154e5fc10cb6a" as const;

export const launchScopeActivationEnvironmentKeys = Object.freeze({
  activationExpiresAt: "NOVALURE_LAUNCH_ACTIVATION_EXPIRES_AT",
  activationGeneration: "NOVALURE_LAUNCH_ACTIVATION_GENERATION",
  activationNotBefore: "NOVALURE_LAUNCH_ACTIVATION_NOT_BEFORE",
  candidateCommit: "NOVALURE_LAUNCH_ACTIVATION_CANDIDATE_COMMIT",
  contract: "NOVALURE_LAUNCH_ACTIVATION_CONTRACT",
  decision: "NOVALURE_LAUNCH_ACTIVATION_DECISION",
  decisionSha256: "NOVALURE_LAUNCH_ACTIVATION_DECISION_SHA256",
  evidenceDeploymentHost: "NOVALURE_LAUNCH_ACTIVATION_EVIDENCE_DEPLOYMENT_HOST",
  evidenceDeploymentId: "NOVALURE_LAUNCH_ACTIVATION_EVIDENCE_DEPLOYMENT_ID",
  documentBundleSha256: "NOVALURE_LAUNCH_ACTIVATION_DOCUMENT_BUNDLE_SHA256",
  finalAttestationSha256: "NOVALURE_LAUNCH_ACTIVATION_FINAL_ATTESTATION_SHA256",
  flagsEnvironment: "NOVALURE_LAUNCH_ACTIVATION_FLAGS_ENVIRONMENT",
  flagsRevisionFloor: "NOVALURE_LAUNCH_ACTIVATION_FLAGS_REVISION_FLOOR",
  policySha256: "NOVALURE_LAUNCH_ACTIVATION_POLICY_SHA256",
  policyVersion: "NOVALURE_LAUNCH_ACTIVATION_POLICY_VERSION",
  productionDeploymentHost: "NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_DEPLOYMENT_HOST",
  productionDeploymentId: "NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_DEPLOYMENT_ID",
  productionHost: "NOVALURE_LAUNCH_ACTIVATION_PRODUCTION_HOST",
  projectId: "NOVALURE_LAUNCH_ACTIVATION_PROJECT_ID",
  receiptSha256: "NOVALURE_LAUNCH_ACTIVATION_RECEIPT_SHA256",
  releaseGateMatrixSha256: "NOVALURE_LAUNCH_ACTIVATION_RELEASE_GATE_MATRIX_SHA256",
  trustAnchorSha256: "NOVALURE_LAUNCH_ACTIVATION_TRUST_ANCHOR_SHA256",
});

type LaunchScopeEnvironment = Readonly<Record<string, string | undefined>>;

export type LaunchScopeProductionActivationBinding = Readonly<{
  activationExpiresAt: string;
  activationGeneration: string;
  activationNotBefore: string;
  candidateCommit: string;
  contract: typeof launchScopeProductionActivationContract;
  decision: "GO";
  decisionSha256: string;
  evidenceDeploymentHost: string;
  evidenceDeploymentId: string;
  documentBundleSha256: string;
  finalAttestationSha256: string;
  flagsEnvironment: string;
  flagsRevisionFloor: string;
  policySha256: string;
  policyVersion: typeof launchScopePolicyVersion;
  productionDeploymentHost: string;
  productionDeploymentId: string;
  productionHost: string;
  projectId: string;
  receiptSha256: string;
  releaseGateMatrixSha256: string;
  trustAnchorSha256: string;
}>;

export type LaunchScopeProductionActivation =
  | { active: true; binding: LaunchScopeProductionActivationBinding }
  | {
      active: false;
      code:
        | "CLIENT_RUNTIME"
        | "RUNTIME_IDENTITY_INVALID"
        | "ACTIVATION_CHANNEL_UNAVAILABLE"
        | "ACTIVATION_CHANNEL_OFF"
        | "ACTIVATION_CHANNEL_INVALID"
        | "ACTIVATION_LEASE_INACTIVE"
        | "ACTIVATION_BINDING_INVALID"
        | "ACTIVATION_BINDING_MISMATCH";
    };

const commitPattern = /^[a-f0-9]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const projectIdPattern = /^prj_[A-Za-z0-9]{12,80}$/u;
const canonicalPositiveIntegerPattern = /^[1-9]\d{0,15}$/u;
const canonicalNonNegativeIntegerPattern = /^(?:0|[1-9]\d{0,15})$/u;
const flagsEnvironmentPattern = /^[A-Za-z0-9_-]{1,160}$/u;
function exactEnvironmentValue(env: LaunchScopeEnvironment, name: string) {
  const value = env[name];
  return typeof value === "string" && value === value.trim() && value.length > 0
    ? value
    : null;
}

function canonicalTimestamp(value: string | null) {
  if (
    value === null
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) return null;
  const parsed = new Date(value);
  const normalized = value.includes(".") ? value : value.replace(/Z$/u, ".000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalized
    ? parsed.getTime()
    : null;
}

/**
 * Resolve the non-secret runtime binding emitted only after external receipt
 * verification. This function performs no crypto and is safe in a shared
 * module. Browser execution always fails closed; only the Node runtime can use
 * the server-side Vercel identity and activation variables.
 */
export function resolveLaunchScopeProductionActivation(
  providedEnvironment?: LaunchScopeEnvironment,
): LaunchScopeProductionActivation {
  if (typeof window !== "undefined") {
    return { active: false, code: "CLIENT_RUNTIME" };
  }
  const env = providedEnvironment ?? process.env;
  const runtimeCandidate = exactEnvironmentValue(env, "VERCEL_GIT_COMMIT_SHA");
  const runtimeDeploymentHost = exactEnvironmentValue(env, "VERCEL_URL");
  const runtimeDeploymentId = exactEnvironmentValue(env, "VERCEL_DEPLOYMENT_ID");
  const runtimeProductionHost = exactEnvironmentValue(env, "VERCEL_PROJECT_PRODUCTION_URL");
  const runtimeProjectId = exactEnvironmentValue(env, "VERCEL_PROJECT_ID");
  if (
    env.VERCEL !== "1"
    || env.VERCEL_ENV !== "production"
    || !runtimeCandidate
    || !commitPattern.test(runtimeCandidate)
    || !runtimeDeploymentId
    || !deploymentIdPattern.test(runtimeDeploymentId)
    || !runtimeDeploymentHost
    || runtimeDeploymentHost !== runtimeDeploymentHost.toLowerCase()
    || !hostPattern.test(runtimeDeploymentHost)
    || !runtimeProductionHost
    || runtimeProductionHost !== runtimeProductionHost.toLowerCase()
    || !hostPattern.test(runtimeProductionHost)
    || !runtimeProjectId
    || !projectIdPattern.test(runtimeProjectId)
  ) {
    return { active: false, code: "RUNTIME_IDENTITY_INVALID" };
  }

  let binding: Record<keyof typeof launchScopeActivationEnvironmentKeys, string | null>;
  if (providedEnvironment === undefined) {
    const snapshot = readLaunchActivationChannelSnapshot();
    const epochNow = Date.now();
    const snapshotEpochAge = snapshot ? epochNow - snapshot.checkedAtEpochMs : null;
    if (
      !snapshot
      || snapshot.validUntilMonotonicMs <= performance.now()
      || snapshotEpochAge === null
      || snapshotEpochAge < -1_000
      || snapshotEpochAge >= 30_000
    ) {
      snapshot?.requestRefresh();
      return { active: false, code: "ACTIVATION_CHANNEL_UNAVAILABLE" };
    }
    if (snapshot.state === "OFF") return { active: false, code: "ACTIVATION_CHANNEL_OFF" };
    if (snapshot.state !== "ACTIVE" || !snapshot.binding) {
      return { active: false, code: "ACTIVATION_CHANNEL_INVALID" };
    }
    const expectedBindingKeys = Object.keys(launchScopeActivationEnvironmentKeys).sort();
    const actualBindingKeys = Object.keys(snapshot.binding).sort();
    if (
      actualBindingKeys.length !== expectedBindingKeys.length
      || !actualBindingKeys.every((key, index) => key === expectedBindingKeys[index])
    ) {
      return { active: false, code: "ACTIVATION_BINDING_INVALID" };
    }
    binding = Object.fromEntries(
      expectedBindingKeys.map((key) => [key, snapshot.binding?.[key] ?? null]),
    ) as Record<keyof typeof launchScopeActivationEnvironmentKeys, string | null>;
  } else {
    const value = (key: keyof typeof launchScopeActivationEnvironmentKeys) =>
      exactEnvironmentValue(env, launchScopeActivationEnvironmentKeys[key]);
    binding = Object.fromEntries(
      Object.keys(launchScopeActivationEnvironmentKeys).map((key) => [
        key,
        value(key as keyof typeof launchScopeActivationEnvironmentKeys),
      ]),
    ) as Record<keyof typeof launchScopeActivationEnvironmentKeys, string | null>;
  }
  const digests = [
    binding.decisionSha256,
    binding.documentBundleSha256,
    binding.finalAttestationSha256,
    binding.policySha256,
    binding.receiptSha256,
    binding.releaseGateMatrixSha256,
    binding.trustAnchorSha256,
  ];
  const activationNotBefore = canonicalTimestamp(binding.activationNotBefore);
  const activationExpiresAt = canonicalTimestamp(binding.activationExpiresAt);
  if (
    !Object.values(binding).every(Boolean)
    || !digests.every((digest) => digestPattern.test(digest ?? ""))
    || binding.contract !== launchScopeProductionActivationContract
    || binding.decision !== "GO"
    || binding.policyVersion !== launchScopePolicyVersion
    || binding.policySha256 !== launchScopePolicySha256
    || binding.decisionSha256 !== launchScopeDecisionSha256
    || activationNotBefore === null
    || activationExpiresAt === null
    || activationExpiresAt <= activationNotBefore
    || activationExpiresAt - activationNotBefore > 30 * 60 * 1_000
    || !canonicalPositiveIntegerPattern.test(binding.activationGeneration ?? "")
    || Number(binding.activationGeneration) < launchScopeProductionMinimumActivationGeneration
    || !canonicalNonNegativeIntegerPattern.test(binding.flagsRevisionFloor ?? "")
    || !flagsEnvironmentPattern.test(binding.flagsEnvironment ?? "")
    || binding.flagsEnvironment !== launchScopeProductionFlagsEnvironment
    || !commitPattern.test(binding.candidateCommit ?? "")
    || !deploymentIdPattern.test(binding.evidenceDeploymentId ?? "")
    || !deploymentIdPattern.test(binding.productionDeploymentId ?? "")
    || !hostPattern.test(binding.evidenceDeploymentHost ?? "")
    || !hostPattern.test(binding.productionDeploymentHost ?? "")
    || !projectIdPattern.test(binding.projectId ?? "")
    || !hostPattern.test(binding.productionHost ?? "")
  ) {
    return { active: false, code: "ACTIVATION_BINDING_INVALID" };
  }
  if (
    binding.candidateCommit !== runtimeCandidate
    || binding.productionDeploymentHost !== runtimeDeploymentHost
    || binding.productionDeploymentId !== runtimeDeploymentId
    || binding.productionHost !== runtimeProductionHost
    || binding.projectId !== runtimeProjectId
  ) {
    return { active: false, code: "ACTIVATION_BINDING_MISMATCH" };
  }
  if (
    providedEnvironment === undefined
    && (
      Date.now() < activationNotBefore
      || Date.now() >= activationExpiresAt
    )
  ) {
    return { active: false, code: "ACTIVATION_LEASE_INACTIVE" };
  }
  return {
    active: true,
    binding: Object.freeze(binding as LaunchScopeProductionActivationBinding),
  };
}

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
  if (typeof window !== "undefined") {
    return {
      allowed: false,
      code: "LAUNCH_SCOPE_RUNTIME_UNSAFE",
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
  const productionActivationRequired =
    vercelEnvironment === "production"
    || (
      process.env.NODE_ENV?.trim().toLowerCase() === "production"
      && vercelEnvironment !== "preview"
    );
  if (
    productionActivationRequired
    && !resolveLaunchScopeProductionActivation().active
  ) {
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
