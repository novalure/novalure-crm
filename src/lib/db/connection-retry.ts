const defaultRetryLimit = 2;

type RetryOptions = {
  onRetry?: (event: { attempt: number; delayMs: number; reason: string }) => void;
  random?: () => number;
  retryLimit?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

function errorChain(error: unknown) {
  const messages: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; sourceError?: unknown };
    if (typeof candidate.code === "string") messages.push(candidate.code);
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.sourceError;
  }

  return messages.join("\n");
}

export function getRetryableDatabaseConnectionReason(error: unknown) {
  const message = errorChain(error);

  if (/failed to acquire permit to connect to the database|too many database connection attempts/i.test(message)) {
    return "neon_connection_permit";
  }
  if (/control plane request failed/i.test(message) && /["']?neon:retryable["']?\s*:\s*true/i.test(message)) {
    return "neon_control_plane";
  }
  if (/(^|\n)(53300|57P03)(\n|$)/.test(message)) {
    return "postgres_connection_capacity";
  }

  return null;
}

export function databaseConnectionRetryDelayMs(attempt: number, random: () => number = Math.random) {
  const safeAttempt = Math.max(1, Math.min(defaultRetryLimit, Math.trunc(attempt) || 1));
  const baseDelay = 100 * 2 ** (safeAttempt - 1);
  const jitter = Math.floor(50 * Math.max(0, Math.min(1, random())));
  return baseDelay + jitter;
}

export async function withDatabaseConnectionRetry<Result>(
  operation: () => Promise<Result>,
  options: RetryOptions = {},
) {
  const retryLimit = Math.max(0, Math.min(defaultRetryLimit, options.retryLimit ?? defaultRetryLimit));
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const reason = getRetryableDatabaseConnectionReason(error);
      if (!reason || attempt >= retryLimit) throw error;

      const delayMs = databaseConnectionRetryDelayMs(attempt + 1, options.random);
      options.onRetry?.({ attempt: attempt + 1, delayMs, reason });
      await sleep(delayMs);
    }
  }
}
