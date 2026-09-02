export type QaDeliveryDecision = Readonly<{
  allowed: false;
  code: "qa_delivery_disabled" | "qa_target_not_allowed" | "provider_adapter_unavailable";
  message: string;
}>;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function evaluateQaOfferDelivery(
  recipientEmail: string,
  env: NodeJS.ProcessEnv = process.env,
): QaDeliveryDecision {
  if (env.NOVALURE_BROKER_OFFER_QA_ENABLED !== "true") {
    return {
      allowed: false,
      code: "qa_delivery_disabled",
      message: "QA offer delivery is disabled. No provider request was made.",
    };
  }

  const allowedTargets = new Set(
    (env.NOVALURE_QA_EMAIL_ALLOWLIST ?? "")
      .split(/[\s,;]+/u)
      .map(normalizeEmail)
      .filter(Boolean),
  );
  if (!allowedTargets.has(normalizeEmail(recipientEmail))) {
    return {
      allowed: false,
      code: "qa_target_not_allowed",
      message: "Recipient is not an approved QA delivery target. No provider request was made.",
    };
  }

  // This slice intentionally ships without an external transport adapter. A
  // configured-looking environment must never be interpreted as acceptance.
  return {
    allowed: false,
    code: "provider_adapter_unavailable",
    message: "No approved offer delivery adapter is installed. No provider request was made.",
  };
}
