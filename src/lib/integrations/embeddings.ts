export type EmbeddingResult = {
  embedding: number[];
  model: string;
  provider: string;
  external: boolean;
  reason?: string;
};

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function cleanEnvValue(value?: string) {
  const trimmed = String(value ?? "").trim();
  const prefixed = trimmed.match(/^[A-Z0-9_]+=([\s\S]+)$/);
  return prefixed?.[1]?.trim() ?? trimmed;
}

function resolveEmbeddingProviderConfig() {
  const configuredBaseUrl =
    process.env.NOVALURE_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const configuredApiKey =
    cleanEnvValue(process.env.NOVALURE_EMBEDDING_API_KEY) || cleanEnvValue(process.env.OPENAI_API_KEY);
  const model = process.env.NOVALURE_EMBEDDING_MODEL || "text-embedding-3-small";

  if (!configuredApiKey) {
    return null;
  }

  return {
    baseUrl: normalizeBaseUrl(configuredBaseUrl),
    apiKey: configuredApiKey,
    model,
    provider: process.env.NOVALURE_EMBEDDING_BASE_URL ? "openai-compatible-embeddings" : "openai-embeddings",
  };
}

export function getEmbeddingProviderStatus() {
  const config = resolveEmbeddingProviderConfig();
  const model = process.env.NOVALURE_EMBEDDING_MODEL || "text-embedding-3-small";

  return {
    configured: Boolean(config),
    provider: config?.provider ?? "deterministic-local",
    model: config?.model ?? model,
    external: Boolean(config),
    reason: config
      ? null
      : "AI Gateway is enabled for chat, but embeddings need OPENAI_API_KEY or NOVALURE_EMBEDDING_API_KEY.",
  };
}

function deterministicEmbedding(text: string, dimensions = 1536) {
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = text.toLowerCase().trim();

  for (let index = 0; index < normalized.length; index += 1) {
    const slot = (normalized.charCodeAt(index) * (index + 17)) % dimensions;
    vector[slot] += ((normalized.charCodeAt(index) % 23) + 1) / 100;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export async function embedText(text: string): Promise<EmbeddingResult> {
  const config = resolveEmbeddingProviderConfig();

  if (!config) {
    return {
      embedding: deterministicEmbedding(text),
      model: "deterministic-local-1536",
      provider: "deterministic-local",
      external: false,
      reason: "OPENAI_API_KEY or NOVALURE_EMBEDDING_API_KEY is not configured",
    };
  }

  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, input: text }),
    });

    if (!response.ok) {
      return {
        embedding: deterministicEmbedding(text),
        model: "deterministic-local-1536",
        provider: "deterministic-local",
        external: false,
        reason: `Embedding provider returned ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;

    if (!embedding?.length) {
      return {
        embedding: deterministicEmbedding(text),
        model: "deterministic-local-1536",
        provider: "deterministic-local",
        external: false,
        reason: "Embedding provider returned an empty vector",
      };
    }

    return { embedding, model: config.model, provider: config.provider, external: true };
  } catch (error) {
    return {
      embedding: deterministicEmbedding(text),
      model: "deterministic-local-1536",
      provider: "deterministic-local",
      external: false,
      reason: error instanceof Error ? error.message : "Embedding provider request failed",
    };
  }
}
