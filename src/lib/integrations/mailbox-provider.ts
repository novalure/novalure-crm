import "server-only";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { hasMailboxReadScope, mailboxAddress, mailboxCursor, mailboxProviderId, mailboxRequestedScopes, mailboxText, type MailboxAttachment, type MailboxImportedMessage, type MailboxProvider } from "@/lib/crm-mailbox";
export type MailboxTransport = (url: string, init: RequestInit) => Promise<Response>;
export class MailboxProviderError extends Error { constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterSeconds?: number) { super(code); } }
const defaultTransport: MailboxTransport = (url, init) => fetch(url, init);
const allowedHosts = new Set(["graph.microsoft.com", "gmail.googleapis.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "login.microsoftonline.com"]);
export async function mailboxProviderJson(url: string, init: RequestInit, transport: MailboxTransport, maxBytes = 1048576): Promise<Record<string, unknown>> {
  const target = new URL(url); if (target.protocol !== "https:" || target.username || target.password || !allowedHosts.has(target.hostname) || target.port) throw new MailboxProviderError("UNSAFE_PROVIDER_URL");
  const response = await transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store" });
  if (!response.ok) { const retry = response.headers.get("retry-after"), seconds = retry ? /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000) : undefined; throw new MailboxProviderError(response.status === 401 || response.status === 403 ? "MAIL_AUTHORIZATION_REQUIRED" : response.status === 429 ? "MAIL_PROVIDER_RATE_LIMIT" : response.status === 404 ? "MAIL_PROVIDER_NOT_FOUND" : response.status === 410 ? "MAIL_CHECKPOINT_EXPIRED" : response.status === 400 && url.includes("/token") ? "MAIL_REAUTH_REQUIRED" : "MAIL_PROVIDER_UNAVAILABLE", response.status, seconds && Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : undefined); }
  const declared = response.headers.get("content-length"); if (declared && Number(declared) > maxBytes) throw new MailboxProviderError("MAIL_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader(); if (!reader) throw new MailboxProviderError("MAIL_INVALID_RESPONSE");
  let length = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > maxBytes) throw new MailboxProviderError("MAIL_RESPONSE_TOO_LARGE"); chunks.push(item.value); } }
  catch (error) { void reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
  try { const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("object required"); return result as Record<string, unknown>; }
  catch { throw new MailboxProviderError("MAIL_INVALID_RESPONSE"); }
}
const json = mailboxProviderJson;
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new MailboxProviderError("MAIL_INVALID_RESPONSE"); return value; }
function received(value: unknown): string { const time = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "string" ? Date.parse(value) : NaN; if (!Number.isFinite(time)) throw new MailboxProviderError("MAIL_INVALID_DATE"); return new Date(time).toISOString(); }
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });
function metadataAttachment(input: Record<string, unknown>, id: unknown, name: unknown, type: unknown, size: unknown): MailboxAttachment {
  const numeric = Number(size); if (!Number.isSafeInteger(numeric) || numeric < 0) throw new MailboxProviderError("MAIL_INVALID_ATTACHMENT");
  return { providerId: mailboxProviderId(id), name: mailboxText(name, 255) || "attachment", mimeType: mailboxText(type, 200) || "application/octet-stream", sizeBytes: numeric, inline: input.isInline === true, status: "quarantined_metadata_only", storedBytes: false };
}
export function parseGoogleMailboxMessage(raw: Record<string, unknown>): MailboxImportedMessage {
  const payload = object(raw.payload), headerRows = Array.isArray(payload.headers) ? payload.headers.slice(0, 200).map(object) : [];
  const header = (name: string) => mailboxText(headerRows.find((item) => String(item.name).toLowerCase() === name)?.value, 2000);
  const attachments: MailboxAttachment[] = [], text: string[] = []; let nodes = 0, noPlain = true, truncated = false;
  const walk = (part: Record<string, unknown>, depth: number) => {
    if (++nodes > 200 || depth > 10) throw new MailboxProviderError("MAIL_MIME_TOO_COMPLEX");
    const body = object(part.body), mime = mailboxText(part.mimeType, 200).toLowerCase(), filename = mailboxText(part.filename, 255);
    if (filename || body.attachmentId) { attachments.push(metadataAttachment(part, body.attachmentId || part.partId || `inline-${nodes}`, filename, mime, body.size ?? 0)); if (attachments.length > 50) throw new MailboxProviderError("MAIL_TOO_MANY_ATTACHMENTS"); return; }
    if (mime === "text/plain" && typeof body.data === "string") {
      if (body.data.length > 262144 || !/^[A-Za-z0-9_=-]*$/.test(body.data)) { truncated = true; return; }
      const content = Buffer.from(body.data, "base64url").toString("utf8"); text.push(content); noPlain = false;
    }
    if (Array.isArray(part.parts)) for (const child of array(part.parts, 100)) walk(object(child), depth + 1);
  };
  walk(payload, 0); const full = noPlain ? mailboxText(raw.snippet, 1000) : text.join("\n");
  return { providerId: mailboxProviderId(raw.id), threadId: typeof raw.threadId === "string" ? mailboxProviderId(raw.threadId) : null, internetMessageId: header("message-id") || null, subject: mailboxText(header("subject"), 1000), fromLabel: header("from"), fromAddress: mailboxAddress(header("from")), toAddresses: header("to").split(",").slice(0, 50).map(mailboxAddress).filter((value): value is string => value !== null), receivedAt: received(raw.internalDate), bodyText: mailboxText(full, 65536), bodyTruncated: noPlain || truncated || full.length > 65536, attachments, senderIdentityVerified: false };
}
export function parseMicrosoftMailboxMessage(raw: Record<string, unknown>, attachmentRows: unknown[]): MailboxImportedMessage {
  const from = object(object(raw.from).emailAddress), body = object(raw.body), plain = String(body.contentType).toLowerCase() === "text", content = plain ? mailboxText(body.content, 65536) : mailboxText(raw.bodyPreview, 1000);
  return { providerId: mailboxProviderId(raw.id), threadId: typeof raw.conversationId === "string" ? mailboxProviderId(raw.conversationId) : null, internetMessageId: mailboxText(raw.internetMessageId, 2000) || null, subject: mailboxText(raw.subject, 1000), fromLabel: mailboxText(from.name || from.address, 1000), fromAddress: mailboxAddress(from.address), toAddresses: (Array.isArray(raw.toRecipients) ? raw.toRecipients.slice(0, 50) : []).map((item) => mailboxAddress(object(object(item).emailAddress).address)).filter((value): value is string => value !== null), receivedAt: received(raw.receivedDateTime), bodyText: content, bodyTruncated: !plain || typeof body.content === "string" && body.content.length > 65536, attachments: attachmentRows.slice(0, 50).map((row) => { const item = object(row); return metadataAttachment(item, item.id, item.name, item.contentType, item.size); }), senderIdentityVerified: false };
}
export async function fetchMailboxPage(input: { provider: MailboxProvider; accessToken: string; grantedScopes: string[]; cursor: string | null; immutableIds?: boolean }, transport: MailboxTransport = defaultTransport) {
  if (!hasMailboxReadScope(input.provider, input.grantedScopes)) throw new MailboxProviderError("MAIL_SCOPE_REQUIRED");
  const cursor = mailboxCursor(input.provider, input.cursor), auth = { ...headers(input.accessToken), ...(input.immutableIds ? { Prefer: 'IdType="ImmutableId"' } : {}) };
  if (input.provider === "google") {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"); url.searchParams.set("maxResults", "5"); url.searchParams.set("labelIds", "INBOX"); if (cursor) url.searchParams.set("pageToken", cursor);
    const list = await json(url.toString(), { headers: auth }, transport), rows = list.messages === undefined ? [] : array(list.messages, 5);
    const messages = await Promise.all(rows.map(async (row) => parseGoogleMailboxMessage(await json(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mailboxProviderId(object(row).id))}?format=full`, { headers: auth }, transport))));
    return { messages, nextCursor: mailboxCursor("google", list.nextPageToken) };
  }
  const url = cursor ? new URL(cursor) : new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  if (!cursor) { url.searchParams.set("$top", "5"); url.searchParams.set("$orderby", "receivedDateTime desc"); url.searchParams.set("$select", "id"); }
  const list = await json(url.toString(), { headers: auth }, transport), rows = array(list.value, 5);
  const messages = await Promise.all(rows.map(async (row) => {
    const id = encodeURIComponent(mailboxProviderId(object(row).id)), detail = await json(`https://graph.microsoft.com/v1.0/me/messages/${id}?$select=id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,hasAttachments`, { headers: { ...auth, Prefer: `${input.immutableIds ? 'IdType="ImmutableId", ' : ''}outlook.body-content-type="text"` } }, transport);
    const attachmentResponse = detail.hasAttachments === true ? await json(`https://graph.microsoft.com/v1.0/me/messages/${id}/attachments?$select=id,name,contentType,size,isInline&$top=50`, { headers: auth }, transport) : null;
    if (attachmentResponse?.["@odata.nextLink"]) throw new MailboxProviderError("MAIL_TOO_MANY_ATTACHMENTS");
    return parseMicrosoftMailboxMessage(detail, attachmentResponse ? array(attachmentResponse.value, 50) : []);
  }));
  return { messages, nextCursor: mailboxCursor("microsoft", list["@odata.nextLink"]) };
}
function tenant() { const value = process.env.MICROSOFT_TENANT_ID?.trim() || "common"; if (!/^[A-Za-z0-9-]+$/.test(value)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG"); return value; }
export function mailboxOAuthConfigured(provider: MailboxProvider) { return Boolean(Buffer.byteLength(process.env.OAUTH_STATE_SECRET || "", "utf8") >= 32 && process.env.OAUTH_TOKEN_ENCRYPTION_KEY && (provider === "google" ? process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)); }
export function mailboxOrigin(requestUrl: string) { if (!["http:", "https:"].includes(new URL(requestUrl).protocol)) throw new MailboxProviderError("MAIL_OAUTH_ORIGIN"); const url = new URL(getTrustedAppOrigin()); if (url.username || url.password || (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new MailboxProviderError("MAIL_OAUTH_ORIGIN"); return url.origin; }
export function mailboxRedirect(provider: MailboxProvider, requestUrl: string) { return `${mailboxOrigin(requestUrl)}/api/crm/mailbox/oauth/${provider}/callback`; }
export function mailboxAuthorizationUrl(input: { provider: MailboxProvider; requestUrl: string; state: string; codeChallenge: string }) {
  if (!mailboxOAuthConfigured(input.provider)) throw new MailboxProviderError("MAIL_OAUTH_NOT_CONFIGURED");
  const url = new URL(input.provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", (input.provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID)!.trim()); url.searchParams.set("redirect_uri", mailboxRedirect(input.provider, input.requestUrl)); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", mailboxRequestedScopes[input.provider].join(" ")); url.searchParams.set("state", input.state); url.searchParams.set("code_challenge", input.codeChallenge); url.searchParams.set("code_challenge_method", "S256");
  if (input.provider === "google") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); } else url.searchParams.set("response_mode", "query"); return url.toString();
}
export async function exchangeMailboxToken(input: { provider: MailboxProvider; code?: string; codeVerifier?: string; requestUrl?: string; refreshToken?: string; priorScopes?: string[] }, transport: MailboxTransport = defaultTransport) {
  const provider = input.provider, body = new URLSearchParams({ client_id: (provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID)?.trim() || "", client_secret: (provider === "google" ? process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_SECRET)?.trim() || "", grant_type: input.refreshToken ? "refresh_token" : "authorization_code" });
  if (!body.get("client_id") || !body.get("client_secret")) throw new MailboxProviderError("MAIL_OAUTH_NOT_CONFIGURED");
  if (input.refreshToken) body.set("refresh_token", input.refreshToken); else { if (!input.code || !input.codeVerifier || !input.requestUrl) throw new MailboxProviderError("MAIL_OAUTH_STATE"); body.set("code", input.code); body.set("code_verifier", input.codeVerifier); body.set("redirect_uri", mailboxRedirect(provider, input.requestUrl)); }
  if (provider === "microsoft") body.set("scope", mailboxRequestedScopes.microsoft.join(" "));
  const result = await json(provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, transport, 65536);
  const scopes = typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : input.refreshToken ? input.priorScopes ?? [] : [];
  if (!hasMailboxReadScope(provider, scopes) || typeof result.access_token !== "string" || !result.access_token || !Number.isSafeInteger(result.expires_in) || Number(result.expires_in) < 30 || Number(result.expires_in) > 86400 || result.token_type && String(result.token_type).toLowerCase() !== "bearer") throw new MailboxProviderError("MAIL_SCOPE_REQUIRED");
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : input.refreshToken ?? null, scopes, expiresAt: new Date(Date.now() + Number(result.expires_in) * 1000).toISOString() };
}
export async function fetchMailboxAccountLabel(provider: MailboxProvider, token: string, transport: MailboxTransport = defaultTransport) {
  const result = await json(provider === "google" ? "https://gmail.googleapis.com/gmail/v1/users/me/profile" : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: headers(token) }, transport, 65536);
  const label = mailboxAddress(provider === "google" ? result.emailAddress : result.mail || result.userPrincipalName);
  if (!label) throw new MailboxProviderError("MAIL_ACCOUNT_UNAVAILABLE"); return label;
}
/** Account keys come from an authenticated provider API, never an unverified token payload. */
export async function fetchMailboxAccountIdentity(provider: MailboxProvider, token: string, transport: MailboxTransport = defaultTransport) {
  const result = await json(provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", { headers: headers(token) }, transport, 65536);
  const label = mailboxAddress(provider === "google" ? result.email : result.mail || result.userPrincipalName), id = provider === "google" ? result.sub : result.id;
  if (!label || typeof id !== "string" || !id || id.length > 512 || provider === "google" && result.email_verified !== true) throw new MailboxProviderError("MAIL_ACCOUNT_UNAVAILABLE");
  return { label, accountId: id };
}
