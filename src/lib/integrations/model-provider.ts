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
  const model = process.env.NOVALURE_LLM_MODEL || "openai/gpt-5.4";

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
  const sourceLine = input.knowledgeTitles.length
    ? input.knowledgeTitles.slice(0, 3).join(", ")
    : input.language === "de"
      ? "keine freigegebenen Quellen gefunden"
      : "no approved sources found";

  const text =
    input.language === "de"
      ? `Ich habe die Anfrage geprüft und nutze aktuell diesen Kontext: ${sourceLine}. ${input.qualificationSummary ?? "Der Lead wird nach den aktiven Bot-Regeln im CRM verarbeitet und auditiert."}`
      : `I reviewed the request and used this context: ${sourceLine}. ${input.qualificationSummary ?? "The lead is handled in CRM under the active bot policy and audit trail."}`;

  return {
    text,
    provider: "deterministic-fallback",
    model: "offline-crm-safe-reply",
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
}): Promise<ModelReply> {
  const config = resolveProviderConfig();
  const model = input.model || process.env.NOVALURE_LLM_MODEL || "openai/gpt-5.4";
  const knowledgeContext = formatKnowledgeContext(input.knowledgeContext);

  if (!config) {
    return fallbackReply({
      prompt: input.prompt,
      language: input.language,
      knowledgeTitles: input.knowledgeTitles ?? [],
      knowledgeContext: input.knowledgeContext,
      qualificationSummary: input.qualificationSummary,
    });
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `${input.system}${knowledgeContext}` },
          ...(input.messages ?? []),
          { role: "user", content: input.prompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return {
        ...fallbackReply({
          prompt: input.prompt,
          language: input.language,
          knowledgeTitles: input.knowledgeTitles ?? [],
          knowledgeContext: input.knowledgeContext,
          qualificationSummary: input.qualificationSummary,
        }),
        reason: `Model provider returned ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      return {
        ...fallbackReply({
          prompt: input.prompt,
          language: input.language,
          knowledgeTitles: input.knowledgeTitles ?? [],
          knowledgeContext: input.knowledgeContext,
          qualificationSummary: input.qualificationSummary,
        }),
        reason: "Model provider returned an empty response",
      };
    }

    return {
      text,
      provider: config.provider,
      model,
      external: true,
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
      reason: error instanceof Error ? error.message : "Model provider request failed",
    };
  }
}
