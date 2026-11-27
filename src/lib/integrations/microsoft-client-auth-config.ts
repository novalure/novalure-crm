/** This is configuration readiness, not proof that the provider accepts a credential. */
export function microsoftClientAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.MICROSOFT_CLIENT_ID?.trim()) return false;
  const mode = env.MICROSOFT_CLIENT_AUTH_METHOD?.trim();
  if (!mode || mode === "client-secret") return Boolean(env.MICROSOFT_CLIENT_SECRET?.trim());
  return mode === "vercel-oidc" && env.VERCEL === "1" && ["production", "preview"].includes(env.VERCEL_ENV || "");
}

/** An explicitly present key, including an empty one, selects the dedicated client. */
export function hasDedicatedMicrosoftMailboxClient(env: NodeJS.ProcessEnv = process.env): boolean {
  const keys = ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET", "MICROSOFT_MAILBOX_PRODUCTION_RELEASE_SHA"] as const;
  return keys.some((key) => env[key] !== undefined);
}

/** A partially configured dedicated mailbox client must never inherit calendar credentials. */
export function microsoftMailboxClientEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!hasDedicatedMicrosoftMailboxClient(env)) return env;
  return {
    ...env,
    MICROSOFT_CLIENT_ID: env.MICROSOFT_MAILBOX_CLIENT_ID,
    MICROSOFT_CLIENT_AUTH_METHOD: env.MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD,
    MICROSOFT_CLIENT_SECRET: env.MICROSOFT_MAILBOX_CLIENT_SECRET,
  };
}

export function microsoftMailboxClientId(env: NodeJS.ProcessEnv = process.env): string {
  return microsoftMailboxClientEnv(env).MICROSOFT_CLIENT_ID?.trim() || "";
}
