import type { FunnelSubmissionPayload } from "@/lib/funnel-schema";
import type { PublicSubmissionProof } from "@/lib/public-submission-contract";
import { sanitizeFunnelSubmissionSourceUrl } from "./funnel-submission-url.js";

export { sanitizeFunnelSubmissionSourceUrl } from "./funnel-submission-url.js";

export function buildFunnelSubmissionRequest(input: {
  answers: FunnelSubmissionPayload["answers"];
  consent: FunnelSubmissionPayload["consent"];
  funnelId: string;
  honeypot?: string;
  intentId?: string;
  mode: FunnelSubmissionPayload["mode"];
  proof?: PublicSubmissionProof;
  utm?: FunnelSubmissionPayload["utm"];
  visitor: FunnelSubmissionPayload["visitor"];
}) {
  const sourceUrl = sanitizeFunnelSubmissionSourceUrl(input.visitor.sourceUrl);
  const payload: FunnelSubmissionPayload = {
    answers: input.answers,
    consent: input.consent,
    funnelId: input.funnelId,
    mode: input.mode,
    publicSubmission: input.mode === "live"
      ? { honeypot: input.honeypot ?? "", intentId: input.intentId, proof: input.proof }
      : undefined,
    utm: input.utm,
    visitor: {
      ...input.visitor,
      sourceUrl,
    },
  };

  return {
    endpoint: `/api/funnels/${encodeURIComponent(input.funnelId)}/submissions`,
    init: {
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
      referrerPolicy: "no-referrer",
    } satisfies RequestInit,
  };
}

const funnelSubmissionIntentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function getOrCreateFunnelSubmissionIntentId(funnelId: string) {
  const storageKey = `novalure:funnel-submission-intent:${funnelId}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing && funnelSubmissionIntentPattern.test(existing)) return existing;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

export function clearFunnelSubmissionIntentId(funnelId: string) {
  try {
    window.sessionStorage.removeItem(`novalure:funnel-submission-intent:${funnelId}`);
  } catch {
    // A successful submission remains durable even when browser storage is unavailable.
  }
}
