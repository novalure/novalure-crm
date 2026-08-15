export type NotificationProvider = "google" | "teams";

export type NotificationTargetReadinessCode =
  | "target_missing"
  | "target_disabled"
  | "target_workspace_mismatch"
  | "target_project_mismatch"
  | "alert_scope_missing"
  | "destination_unsupported"
  | "credential_missing"
  | "credential_invalid";

export type NotificationTargetCandidate = {
  alertTypes: readonly string[] | null;
  destinationType: string | null;
  enabled: boolean;
  projectId?: string | null;
  webhookUrl?: string | null;
  workspaceId: string;
};

export type NotificationTargetReadiness =
  | {
      health: "configured";
      ok: true;
      provider: NotificationProvider;
    }
  | {
      adminAction: string;
      code: NotificationTargetReadinessCode;
      health: "blocked";
      ok: false;
      reason: string;
      retryable: false;
    };

const readinessFailures: Record<
  NotificationTargetReadinessCode,
  { adminAction: string; reason: string }
> = {
  alert_scope_missing: {
    adminAction: "Enable this alert type on the provider target, then reconcile the job explicitly.",
    reason: "The configured provider target is not authorized for this alert type.",
  },
  credential_invalid: {
    adminAction: "Replace the webhook credential with a valid provider-issued HTTPS URL, then run the test-sink check.",
    reason: "The provider credential is not a valid webhook URL for the selected provider.",
  },
  credential_missing: {
    adminAction: "Store a provider-issued webhook credential on the target, then run the test-sink check.",
    reason: "The provider target has no webhook credential.",
  },
  destination_unsupported: {
    adminAction: "Select the supported webhook destination or complete the required OAuth provider implementation.",
    reason: "The selected provider destination is not supported by the active delivery worker.",
  },
  target_disabled: {
    adminAction: "Enable an authorized provider target, validate it, and reconcile the job explicitly.",
    reason: "The provider target is disabled.",
  },
  target_missing: {
    adminAction: "Create an authorized provider target for this workspace or project, then reconcile the job explicitly.",
    reason: "No provider target is configured for this workspace or project.",
  },
  target_project_mismatch: {
    adminAction: "Choose a workspace target or a target assigned to the same project, then reconcile the job explicitly.",
    reason: "The provider target is assigned to a different project.",
  },
  target_workspace_mismatch: {
    adminAction: "Choose a target from the job workspace; cross-workspace reconciliation is not allowed.",
    reason: "The provider target belongs to a different workspace.",
  },
};

export function getNotificationReadinessFailure(
  code: NotificationTargetReadinessCode,
): Extract<NotificationTargetReadiness, { ok: false }> {
  return {
    ...readinessFailures[code],
    code,
    health: "blocked",
    ok: false,
    retryable: false,
  };
}

export function validateNotificationTargetReadiness(input: {
  alertType: string;
  projectId?: string | null;
  provider: NotificationProvider;
  target: NotificationTargetCandidate | null;
  workspaceId: string;
}): NotificationTargetReadiness {
  const target = input.target;
  if (!target) return getNotificationReadinessFailure("target_missing");
  if (target.workspaceId !== input.workspaceId) {
    return getNotificationReadinessFailure("target_workspace_mismatch");
  }
  if (target.projectId && target.projectId !== (input.projectId ?? null)) {
    return getNotificationReadinessFailure("target_project_mismatch");
  }
  if (!target.enabled) return getNotificationReadinessFailure("target_disabled");
  if (!target.alertTypes?.includes(input.alertType)) {
    return getNotificationReadinessFailure("alert_scope_missing");
  }

  const expectedDestination = input.provider === "google"
    ? "google_chat_webhook"
    : "incoming_webhook";
  if (target.destinationType !== expectedDestination) {
    return getNotificationReadinessFailure("destination_unsupported");
  }
  if (!target.webhookUrl?.trim()) {
    return getNotificationReadinessFailure("credential_missing");
  }
  if (!isProviderWebhookUrl(input.provider, target.webhookUrl)) {
    return getNotificationReadinessFailure("credential_invalid");
  }

  return { health: "configured", ok: true, provider: input.provider };
}

export function validateNotificationTestSinkUrl(input: {
  allowInsecureLocalhost?: boolean;
  value: string;
}) {
  let url: URL;
  try {
    url = new URL(input.value);
  } catch {
    return { ok: false as const, reason: "notification_test_sink_invalid" };
  }

  const isLocalhost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    (!isLocalhost && url.protocol !== "https:") ||
    (isLocalhost && url.protocol !== "https:" && !(input.allowInsecureLocalhost && url.protocol === "http:")) ||
    isProviderHostname(url.hostname)
  ) {
    return { ok: false as const, reason: "notification_test_sink_invalid" };
  }

  return { ok: true as const, url: url.toString() };
}

export async function runNotificationTestSinkProbe(input: {
  allowInsecureLocalhost?: boolean;
  fetchImpl?: typeof fetch;
  provider: NotificationProvider;
  sinkUrl: string;
  targetId: string;
  timeoutMs?: number;
}) {
  const sink = validateNotificationTestSinkUrl({
    allowInsecureLocalhost: input.allowInsecureLocalhost,
    value: input.sinkUrl,
  });
  if (!sink.ok) {
    return { adminAction: "Configure a dedicated non-provider test sink URL.", ok: false as const, reason: sink.reason };
  }

  const response = await (input.fetchImpl ?? fetch)(sink.url, {
    body: JSON.stringify({
      probe: "novalure_notification_test_sink_v1",
      provider: input.provider,
      targetId: input.targetId,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
  });
  if (!response.ok) {
    return {
      adminAction: "Repair the dedicated test sink before validating notification egress again.",
      ok: false as const,
      reason: `notification_test_sink_http_${response.status}`,
    };
  }

  return { mode: "test_sink" as const, ok: true as const };
}

function isProviderWebhookUrl(provider: NotificationProvider, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (provider === "google") {
    return hostname === "chat.googleapis.com" &&
      /^\/v1\/spaces\/[^/]+\/messages$/u.test(url.pathname) &&
      Boolean(url.searchParams.get("key")) &&
      Boolean(url.searchParams.get("token"));
  }

  const hasOpaquePath = url.pathname.length > 1;
  const isLegacyOfficeWebhook = hostname === "outlook.office.com" && url.pathname.includes("/webhook/");
  const isOfficeWebhook = hostname.endsWith(".webhook.office.com") && hasOpaquePath;
  const hasSasSignature = Boolean(url.searchParams.get("sig") || url.searchParams.get("signature"));
  const isLogicAppWebhook = hostname.endsWith(".logic.azure.com") &&
    url.pathname.includes("/workflows/") &&
    url.pathname.includes("/triggers/") &&
    hasSasSignature;
  const isPowerPlatformWebhook = hostname.endsWith(".environment.api.powerplatform.com") &&
    url.pathname.startsWith("/powerautomate/automations/") &&
    hasSasSignature;
  return isLegacyOfficeWebhook || isOfficeWebhook || isLogicAppWebhook || isPowerPlatformWebhook;
}

function isProviderHostname(value: string) {
  const hostname = value.toLowerCase();
  return hostname === "chat.googleapis.com" ||
    hostname === "outlook.office.com" ||
    hostname.endsWith(".webhook.office.com") ||
    hostname.endsWith(".logic.azure.com") ||
    hostname.endsWith(".environment.api.powerplatform.com");
}
