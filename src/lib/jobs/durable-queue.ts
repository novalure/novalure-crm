import { randomUUID } from "node:crypto";

export const JOB_ERROR_LIMIT = 500;
export const JOB_LEASE_SECONDS = 45;
export const PROVIDER_TIMEOUT_MS = 12_000;

export type DeliveryErrorCategory =
  | "configuration"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_rejected"
  | "provider_timeout"
  | "transient"
  | "unknown";

export function createLeaseOwner(queue: string) {
  return `${queue}:${randomUUID()}`;
}

export function sanitizeJobError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || "Unknown delivery error");

  return message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/(?:token|secret|password|authorization|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, JOB_ERROR_LIMIT);
}

export function classifyDeliveryError(input: { error?: unknown; status?: number | null }): DeliveryErrorCategory {
  const message = sanitizeJobError(input.error).toLowerCase();
  const status = input.status ?? 0;

  if (status === 401 || status === 403) return "provider_auth";
  if (status === 429) return "provider_rate_limit";
  if (status >= 400 && status < 500) return "provider_rejected";
  if (status >= 500) return "transient";
  if (/timeout|timed out|abort/.test(message)) return "provider_timeout";
  if (/missing|not configured|no .*url|configuration/.test(message)) return "configuration";
  if (/network|fetch|connection|temporar/.test(message)) return "transient";
  return "unknown";
}

export function retryDelaySeconds(attempt: number, random: () => number = Math.random) {
  const safeAttempt = Math.max(1, Math.min(10, Math.trunc(attempt) || 1));
  const base = Math.min(3_600, 30 * 2 ** (safeAttempt - 1));
  const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(1, random())));
  return base + jitter;
}
