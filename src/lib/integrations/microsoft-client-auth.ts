import "server-only";
import { exchangeVercelOidcToken, getVercelOidcTokenSync } from "@vercel/oidc";
import { microsoftClientAuthConfigured, microsoftMailboxClientEnv } from "./microsoft-client-auth-config";

export class MicrosoftClientAuthError extends Error {
  constructor(message: "MICROSOFT_CLIENT_AUTH_NOT_CONFIGURED" | "MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", public readonly kind: "configuration" | "unavailable") { super(message); }
}
const transientNetworkCodes = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function assertionErrorKind(error: unknown): "configuration" | "unavailable" {
  if (error instanceof MicrosoftClientAuthError) return error.kind;
  if (error instanceof TypeError && error.cause && typeof error.cause === "object" && "code" in error.cause && typeof error.cause.code === "string" && transientNetworkCodes.has(error.cause.code)) return "unavailable";
  // Unknown SDK failures may indicate permanent authorization/configuration
  // problems. Do not silently reclassify them as transient provider outages.
  return "configuration";
}

/** Use the current invocation's token only. The SDK may hold an exchanged token in memory;
 * skipCache prevents this path from reusing one on a subsequent request. */
export async function microsoftClientAuthFields(
  env: NodeJS.ProcessEnv = process.env,
  getAssertion: () => string | Promise<string> = async () => {
    let token: string;
    try { token = getVercelOidcTokenSync(); }
    catch { throw new MicrosoftClientAuthError("MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", "configuration"); }
    return exchangeVercelOidcToken({ token, audience: "api://AzureADTokenExchange", skipCache: true });
  },
): Promise<Record<string, string>> {
  if (!microsoftClientAuthConfigured(env)) throw new MicrosoftClientAuthError("MICROSOFT_CLIENT_AUTH_NOT_CONFIGURED", "configuration");
  const clientId = env.MICROSOFT_CLIENT_ID!.trim();
  if (env.MICROSOFT_CLIENT_AUTH_METHOD?.trim() !== "vercel-oidc") {
    return { client_id: clientId, client_secret: env.MICROSOFT_CLIENT_SECRET!.trim() };
  }
  if (env.VERCEL_OIDC_TOKEN || env.VERCEL_OIDC_TOKEN_FILE) throw new MicrosoftClientAuthError("MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", "configuration");
  let assertion: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The SDK exposes no cancellation signal. A timed-out call can finish in
    // the background, but its eventual assertion must never resume this flow.
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MicrosoftClientAuthError("MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", "unavailable")), 8_000); });
    assertion = await Promise.race([Promise.resolve().then(getAssertion), deadline]);
  } catch (error) {
    throw new MicrosoftClientAuthError("MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", assertionErrorKind(error));
  } finally { if (timer) clearTimeout(timer); }
  if (!assertion || typeof assertion !== "string") throw new MicrosoftClientAuthError("MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE", "configuration");
  return { client_id: clientId, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion };
}

export async function microsoftMailboxClientAuthFields(
  env: NodeJS.ProcessEnv = process.env,
  getAssertion?: () => string | Promise<string>,
): Promise<Record<string, string>> {
  return microsoftClientAuthFields(microsoftMailboxClientEnv(env), getAssertion);
}
