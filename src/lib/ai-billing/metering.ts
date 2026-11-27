/** Server-side metering policy. Never accept rates or token limits from a customer request. */
export const AI_METER_VERSION = "2026-11-04-v1";
export const AI_DEFAULT_MODEL = "openai/gpt-5.4-mini";
export const AI_MAX_INPUT_BYTES = 65_536;
export const AI_MAX_OUTPUT_TOKENS = 1_024;
export const AI_PROVIDER_TIMEOUT_MS = 20_000;

// Includes a 10% regional-processing reserve; cached input is conservatively billed at the input rate.
// One credit represents at most approximately USD 0.001 of provider usage at these fixed rates.
export const AI_MODEL_RATES = Object.freeze({
  "openai/gpt-5.4-mini": { inputCreditsPerMillion: 825, outputCreditsPerMillion: 4_950 },
  "openai/gpt-5.4": { inputCreditsPerMillion: 2_750, outputCreditsPerMillion: 16_500 },
} as const);

export type MeteredAiModel = keyof typeof AI_MODEL_RATES;
export type MeteredMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

export function resolveMeteredModel(value?: string): MeteredAiModel {
  const model = value || AI_DEFAULT_MODEL;
  if (!Object.hasOwn(AI_MODEL_RATES, model)) throw new Error("AI_MODEL_NOT_ALLOWED");
  return model as MeteredAiModel;
}

export function aiCreditsForTokens(model: MeteredAiModel, inputTokens: number, outputTokens: number) {
  if (![inputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("AI_USAGE_INVALID");
  const rate = AI_MODEL_RATES[model];
  return Math.max(1, Math.ceil((inputTokens * rate.inputCreditsPerMillion + outputTokens * rate.outputCreditsPerMillion) / 1_000_000));
}

/** UTF-8 bytes provide a deliberately conservative bound, including per-message framing. */
export function reserveForMessages(model: MeteredAiModel, messages: readonly MeteredMessage[]) {
  if (!messages.length || messages.length > 20) throw new Error("AI_CONTEXT_TOO_LARGE");
  let inputTokenBound = 256;
  for (const message of messages) {
    if (typeof message.content !== "string") throw new Error("AI_CONTEXT_INVALID");
    inputTokenBound += Buffer.byteLength(message.content, "utf8") + 32;
  }
  if (inputTokenBound > AI_MAX_INPUT_BYTES) throw new Error("AI_CONTEXT_TOO_LARGE");
  return { inputTokenBound, maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    credits: aiCreditsForTokens(model, inputTokenBound, AI_MAX_OUTPUT_TOKENS) };
}

export function readProviderTokenUsage(value: unknown, inputBound: number, outputBound: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number" ||
      !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 ||
      input > inputBound || output > outputBound) return null;
  // completion_tokens already includes reasoning tokens; adding the details would count them twice.
  return { inputTokens: input, outputTokens: output };
}
