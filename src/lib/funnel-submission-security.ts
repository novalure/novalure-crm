import "server-only";

import type { FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { FunnelSubmissionValidationError } from "@/lib/funnel-submission-validation";
import {
  sanitizeFunnelSubmissionAnswerUrl,
  sanitizeFunnelSubmissionSourceUrl,
} from "@/lib/funnel-submission-url";

const capabilitySecretPattern = /^[A-Za-z0-9_-]{43}$/u;
const embeddedCapabilitySecretPattern =
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?:$|[^A-Za-z0-9_-])/u;
const sensitiveCapabilityFieldKeys = new Set([
  "accesstoken",
  "capabilitytoken",
  "publishtoken",
  "publictoken",
  "token",
]);

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z]/gu, "");
}

function decodedVariants(value: string) {
  const variants = [value];
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    const next = current.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === current) return { exhausted: false, variants };
    variants.push(next);
    current = next;
  }

  const next = current.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return { exhausted: next !== current, variants };
}

function assertNoCapabilitySecret(input: {
  key: string;
  knownTokens: string[];
  value: string;
}) {
  const trimmed = input.value.trim();
  if (!trimmed) return;
  const valueVariants = decodedVariants(input.value);
  const keyVariants = decodedVariants(input.key);
  const carriesKnownToken = input.knownTokens.some((token) =>
    valueVariants.variants.some((value) => value.includes(token))
  );
  if (
    valueVariants.exhausted ||
    keyVariants.exhausted ||
    carriesKnownToken ||
    valueVariants.variants.some((value) => capabilitySecretPattern.test(value.trim())) ||
    valueVariants.variants.some((value) => embeddedCapabilitySecretPattern.test(value)) ||
    keyVariants.variants.some((key) => sensitiveCapabilityFieldKeys.has(normalizedKey(key)))
  ) {
    throw new FunnelSubmissionValidationError("funnel_capability_secret_rejected", 422);
  }
}

function assertNoCapabilitySecretInKey(key: string, knownTokens: string[]) {
  assertNoCapabilitySecret({ key, knownTokens, value: key });
}

function sanitizeAnswerValue(input: {
  key: string;
  knownTokens: string[];
  value: FunnelSubmissionPayload["answers"][string];
}) {
  if (typeof input.value === "string") {
    const sanitized = sanitizeFunnelSubmissionAnswerUrl(input.value);
    assertNoCapabilitySecret({ ...input, value: sanitized });
    return sanitized;
  }
  if (Array.isArray(input.value)) {
    return input.value.map((value) => {
      const sanitized = sanitizeFunnelSubmissionAnswerUrl(value);
      assertNoCapabilitySecret({ key: input.key, knownTokens: input.knownTokens, value: sanitized });
      return sanitized;
    });
  }
  return input.value;
}

/** Sanitizes every string that reaches raw_payload, tracking, audit, or analytics. */
export function sanitizeFunnelSubmissionForPersistence(input: {
  payload: FunnelSubmissionPayload;
  storedTracking: Record<string, unknown> | undefined;
}): FunnelSubmissionPayload {
  const knownTokens = [
    input.storedTracking?.publishToken,
    input.storedTracking?.publicToken,
  ].filter((value): value is string => typeof value === "string" && Boolean(value));
  const answers = Object.fromEntries(
    Object.entries(input.payload.answers).map(([key, value]) => {
      assertNoCapabilitySecretInKey(key, knownTokens);
      return [key, sanitizeAnswerValue({ key, knownTokens, value })];
    }),
  );
  const utm = input.payload.utm
    ? Object.fromEntries(Object.entries(input.payload.utm).map(([key, value]) => {
        assertNoCapabilitySecretInKey(key, knownTokens);
        const sanitized = sanitizeFunnelSubmissionAnswerUrl(value);
        assertNoCapabilitySecret({ key, knownTokens, value: sanitized });
        return [key, sanitized];
      }))
    : undefined;
  for (const [key, value] of Object.entries(input.payload.visitor)) {
    if (key === "sourceUrl" || typeof value !== "string") continue;
    assertNoCapabilitySecret({ key, knownTokens, value });
  }
  const sourceUrl = sanitizeFunnelSubmissionSourceUrl(input.payload.visitor.sourceUrl);
  if (sourceUrl) {
    assertNoCapabilitySecret({ key: "sourceUrl", knownTokens, value: sourceUrl });
  }

  return {
    ...input.payload,
    answers,
    utm,
    visitor: {
      ...input.payload.visitor,
      sourceUrl,
    },
  };
}
