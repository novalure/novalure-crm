import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { reserveAiCredits, settleAiCredits } from "@/lib/ai-billing/repository";
import {
  AI_DEFAULT_MODEL, AI_METER_VERSION, AI_PROVIDER_TIMEOUT_MS,
  aiCreditsForTokens, readProviderTokenUsage, reserveForMessages, resolveMeteredModel,
} from "@/lib/ai-billing/metering";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelReply = {
  text: string;
  provider: string;
  model: string;
  external: boolean;
  reason?: string;
  metering?: {
    requestId: string;
    status: "settled" | "reserved" | "blocked";
    chargedCredits: number;
    reservedCredits: number;
  };
};

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function resolveProviderConfig() {
  const aiGatewayKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY;

  if (aiGatewayKey) {
    return {
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      apiKey: aiGatewayKey,
      provider: "vercel-ai-gateway",
    };
  }

  if (process.env.NOVALURE_LLM_BASE_URL && process.env.NOVALURE_LLM_API_KEY) {
    return {
      baseUrl: normalizeBaseUrl(process.env.NOVALURE_LLM_BASE_URL),
      apiKey: process.env.NOVALURE_LLM_API_KEY,
      provider: "openai-compatible",
    };
  }

  return null;
}

export function getModelProviderStatus() {
  const config = resolveProviderConfig();
  const model = process.env.NOVALURE_LLM_MODEL || AI_DEFAULT_MODEL;

  return {
    configured: Boolean(config),
    provider: config?.provider ?? "deterministic-fallback",
    model,
    external: Boolean(config),
  };
}

function fallbackReply(input: {
  prompt: string;
  language: string;
  knowledgeTitles: string[];
  knowledgeContext?: Array<{ title: string; excerpt: string; citationUrl?: string | null }>;
  qualificationSummary?: string;
}): ModelReply {
  const approvedContext = (input.knowledgeContext ?? [])
    .filter((source) => source.title.trim() && source.excerpt.trim())
    .slice(0, 3);

  if (approvedContext.length) {
    const excerpts = approvedContext
      .map((source, index) => {
        const citation = source.citationUrl ? ` (${source.citationUrl})` : "";
        return `${index + 1}. ${source.title}${citation}: ${source.excerpt}`;
      })
      .join("\n");
    const text =
      input.language === "de"
        ? `Auf Basis der freigegebenen Wissensquelle kann ich Folgendes nennen:\n${excerpts}\n\nFür Details oder unklare Punkte bereite ich die Übergabe an das Team vor.`
        : `Based on the approved knowledge source, I can share this:\n${excerpts}\n\nFor details or unclear points, I will prepare a handoff to the team.`;

    return {
      text,
      provider: "deterministic-fallback",
      model: "offline-crm-grounded-reply",
      external: false,
      reason: "NOVALURE_LLM_BASE_URL or NOVALURE_LLM_API_KEY is not configured",
    };
  }

  const sourceLine = input.knowledgeTitles.length
    ? input.knowledgeTitles.slice(0, 3).join(", ")
    : input.language === "de"
      ? "keine freigegebenen Quellen gefunden"
      : "no approved sources found";

  return {
    text:
      input.language === "de"
        ? `Dazu habe ich aktuell keine freigegebene Wissensquelle (${sourceLine}). Ich speichere die Anfrage im CRM und bereite die Übergabe an das Team vor.`
        : `I do not currently have an approved knowledge source (${sourceLine}). I will save the enquiry in CRM and prepare a handoff to the team.`,
    provider: "deterministic-fallback",
    model: "offline-crm-handoff-reply",
    external: false,
    reason: "NOVALURE_LLM_BASE_URL or NOVALURE_LLM_API_KEY is not configured",
  };
}

function formatKnowledgeContext(
  knowledgeContext: Array<{ title: string; excerpt: string; citationUrl?: string | null; score?: number }> | undefined,
) {
  if (!knowledgeContext?.length) return "";

  const entries = knowledgeContext.slice(0, 5).map((source, index) => {
    const citation = source.citationUrl ? ` (${source.citationUrl})` : "";
    const score = typeof source.score === "number" ? ` score ${source.score.toFixed(2)}` : "";
    return `[${index + 1}] ${source.title}${citation}${score}: ${source.excerpt}`;
  });

  return `\n\nApproved knowledge context with citations:\n${entries.join("\n")}`;
}

export async function generateModelReply(input: {
  system: string;
  prompt: string;
  messages?: ChatMessage[];
  model?: string;
  language: string;
  knowledgeTitles?: string[];
  knowledgeContext?: Array<{ title: string; excerpt: string; citationUrl?: string | null; score?: number }>;
  qualificationSummary?: string;
  /** Verified server-side workspace authority; never populated from a browser payload. */
  session?: AppSession;
  /** Server-assigned operation identity. Reusing a reservation never repeats a remote call. */
  requestId?: string;
}, options: TenantTransactionOptions = {}): Promise<ModelReply> {
  const config = resolveProviderConfig();
  const knowledgeContext = formatKnowledgeContext(input.knowledgeContext);
  const fallback = (reason: string): ModelReply => ({
    ...fallbackReply({ ...input, knowledgeTitles: input.knowledgeTitles ?? [] }), reason,
  });

  if (!config) {
    return fallbackReply({
      prompt: input.prompt,
      language: input.language,
      knowledgeTitles: input.knowledgeTitles ?? [],
      knowledgeContext: input.knowledgeContext,
      qualificationSummary: input.qualificationSummary,
    });
  }

  const requestId = input.requestId ?? randomUUID();
  let model: ReturnType<typeof resolveMeteredModel>;
  let reservation: ReturnType<typeof reserveForMessages>;
  const messages: ChatMessage[] = [
    { role: "system", content: `${input.system}${knowledgeContext}` },
    ...(input.messages ?? []),
    { role: "user", content: input.prompt },
  ];
  try {
    model = resolveMeteredModel(input.model || process.env.NOVALURE_LLM_MODEL || AI_DEFAULT_MODEL);
    reservation = reserveForMessages(model, messages);
  } catch (error) {
    return fallback(error instanceof Error ? error.message : "AI_POLICY_BLOCKED");
  }
  // No preview identity or unbound channel surrogate may spend a company's credits.
  if (!input.session?.authenticated || !["cookie", "database"].includes(input.session.source) ||
      !/^[0-9a-f-]{36}$/i.test(input.session.userId)) return fallback("AI_BILLING_AUTH_REQUIRED");
  const requestHash = createHash("sha256").update(JSON.stringify({ model, messages, meter: AI_METER_VERSION })).digest("hex");
  try {
    const held = await reserveAiCredits(input.session, {
      requestId, operation: "chat", credits: reservation.credits,
      metadata: { model, requestHash, meterVersion: AI_METER_VERSION,
        inputTokenBound: reservation.inputTokenBound, maxOutputTokens: reservation.maxOutputTokens },
    }, options);
    if (held.replayed) return { ...fallback("AI_REQUEST_ALREADY_RESERVED"),
      metering: { requestId, status: "reserved", chargedCredits: 0, reservedCredits: reservation.credits } };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "AI_BILLING_UNAVAILABLE";
    return { ...fallback(code), metering: { requestId, status: "blocked", chargedCredits: 0, reservedCredits: 0 } };
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": requestId,
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: reservation.maxOutputTokens,
        reasoning_effort: "none",
      }),
    });

    if (!response.ok) {
      // A definite request rejection consumes nothing. Network/5xx outcomes stay reserved for reconciliation.
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        await settleAiCredits(input.session, { requestId, actualCredits: 0, status: "failed" }, options);
        return { ...fallback("AI_PROVIDER_REJECTED"), metering: { requestId, status: "settled", chargedCredits: 0, reservedCredits: 0 } };
      }
      throw new Error("AI_PROVIDER_OUTCOME_UNKNOWN");
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    const usage = readProviderTokenUsage(data.usage, reservation.inputTokenBound, reservation.maxOutputTokens);
    if (!usage) throw new Error("AI_USAGE_PENDING_REVIEW");
    const actualCredits = aiCreditsForTokens(model, usage.inputTokens, usage.outputTokens);
    await settleAiCredits(input.session, { requestId, actualCredits, status: "succeeded" }, options);
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      return { ...fallback("AI_PROVIDER_EMPTY_REPLY"), metering: { requestId, status: "settled", chargedCredits: actualCredits, reservedCredits: 0 } };
    }

    return {
      text,
      provider: config.provider,
      model,
      external: true,
      metering: { requestId, status: "settled", chargedCredits: actualCredits, reservedCredits: 0 },
    };
  } catch (error) {
    return {
      ...fallbackReply({
        prompt: input.prompt,
        language: input.language,
        knowledgeTitles: input.knowledgeTitles ?? [],
        knowledgeContext: input.knowledgeContext,
        qualificationSummary: input.qualificationSummary,
      }),
      reason: error instanceof Error && error.message === "AI_USAGE_PENDING_REVIEW" ? error.message : "AI_PROVIDER_OUTCOME_UNKNOWN",
      metering: { requestId, status: "reserved", chargedCredits: 0, reservedCredits: reservation.credits },
    };
  }
}
