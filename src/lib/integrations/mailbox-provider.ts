import "server-only";
import { hasDedicatedMicrosoftMailboxClient, microsoftClientAuthConfigured, microsoftMailboxClientEnv, microsoftMailboxClientId } from "./microsoft-client-auth-config";
import { MicrosoftClientAuthError, microsoftMailboxClientAuthFields } from "./microsoft-client-auth";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { getBuildMetadata } from "@/lib/build-metadata";
import { publicSiteOrigin } from "@/lib/legal";
import { hasMailboxReadScope, hasVerifiedMicrosoftMailboxScopes, mailboxAddress, mailboxCursor, mailboxProviderId, mailboxRequestedScopes, mailboxText, microsoftMailboxCursorCandidate, type MailboxAttachment, type MailboxImportedMessage, type MailboxProvider } from "@/lib/crm-mailbox";
export type MailboxTransport = (url: string, init: RequestInit) => Promise<Response>;
export class MailboxProviderError extends Error { constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterSeconds?: number) { super(code); } }
/** Missing or malformed labels are unknown, not evidence that mail left Inbox. */
export function gmailMessageLabels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new MailboxProviderError("MAIL_INVALID_GMAIL_LABEL_IDS");
  try { return value.map((label) => mailboxProviderId(label)); }
  catch { throw new MailboxProviderError("MAIL_INVALID_GMAIL_LABEL_IDS"); }
}
/** A detail read after an Inbox observation must still describe that same item. */
export function assertGmailInboxDetail(raw: Record<string, unknown>, expectedId: string): void {
  const labels = gmailMessageLabels(raw.labelIds);
  let id: string;
  try { id = mailboxProviderId(raw.id); } catch { throw new MailboxProviderError("MAIL_GMAIL_DETAIL_CHANGED"); }
  if (id !== expectedId || !labels.includes("INBOX")) throw new MailboxProviderError("MAIL_GMAIL_DETAIL_CHANGED");
}
const defaultTransport: MailboxTransport = (url, init) => fetch(url, init);
const allowedHosts = new Set(["graph.microsoft.com", "gmail.googleapis.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "login.microsoftonline.com"]);
// Entra documents these as expiration or revocation of the refresh grant.
// The OAuth error must independently identify that grant as invalid.
const revokedOrExpiredMicrosoftRefreshCodes = new Set([50173, 70008, 700082, 700084, 70043]);
function providerRetryAfter(response: Response): number | undefined {
  const retry = response.headers.get("retry-after");
  const seconds = retry ? /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000) : undefined;
  return seconds && Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : undefined;
}
function verifiedMicrosoftRefreshFailure(result: Record<string, unknown>, response: Response) {
  const { status } = response;
  const codes = result.error_codes;
  if (status === 400 && result.error === "invalid_grant" &&
      Array.isArray(codes) && codes.length === 1 && revokedOrExpiredMicrosoftRefreshCodes.has(codes[0])) {
    return new MailboxProviderError("MAIL_REAUTH_REQUIRED", status, providerRetryAfter(response));
  }
  return new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE", status, providerRetryAfter(response));
}

export async function mailboxProviderJson(url: string, init: RequestInit, transport: MailboxTransport, maxBytes = 1048576, verifiedMicrosoftRefresh = false): Promise<Record<string, unknown>> {
  const target = new URL(url); if (target.protocol !== "https:" || target.username || target.password || !allowedHosts.has(target.hostname) || target.port) throw new MailboxProviderError("UNSAFE_PROVIDER_URL");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  // Abort is advisory: cap the whole request even if a transport ignores it.
  // A timed-out token exchange may already have rotated the provider token;
  // the lost response may require the user to reconnect their mailbox.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE")); controller.abort(); }, 10000);
  });
  const cancel = (body: ReadableStream<Uint8Array> | null) => {
    try { if (body) void body.cancel().catch(() => undefined); } catch { /* best effort */ }
  };
  try {
    const pending = transport(url, { ...init, redirect: "error", signal: controller.signal, cache: "no-store" }).then(value => {
      if (controller.signal.aborted) { cancel(value.body); throw new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE"); }
      return value;
    });
    response = await Promise.race([pending, deadline]);
    const readMicrosoftRefreshFailure = verifiedMicrosoftRefresh && [400, 401, 403].includes(response.status);
    if (!response.ok && !readMicrosoftRefreshFailure) { throw new MailboxProviderError(response.status === 401 || response.status === 403 ? "MAIL_AUTHORIZATION_REQUIRED" : response.status === 429 ? "MAIL_PROVIDER_RATE_LIMIT" : response.status === 404 ? "MAIL_PROVIDER_NOT_FOUND" : response.status === 410 ? "MAIL_CHECKPOINT_EXPIRED" : response.status === 400 && url.includes("/token") ? "MAIL_REAUTH_REQUIRED" : "MAIL_PROVIDER_UNAVAILABLE", response.status, providerRetryAfter(response)); }
    const responseLimit = readMicrosoftRefreshFailure ? Math.min(maxBytes, 16_384) : maxBytes;
    const declared = response.headers.get("content-length"); if (declared && Number(declared) > responseLimit) throw new MailboxProviderError("MAIL_RESPONSE_TOO_LARGE");
    reader = response.body?.getReader(); if (!reader) throw new MailboxProviderError("MAIL_INVALID_RESPONSE");
    let length = 0, reads = 0; const chunks: Uint8Array[] = [];
    while (true) {
      const item = await Promise.race([reader.read(), deadline]); if (item.done) { complete = true; break; }
      // Fragmentation says nothing about the size or validity of the message.
      // Keep this failure retryable instead of quarantining a valid message.
      if (++reads > 8192) throw new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE");
      length += item.value.byteLength; if (length > responseLimit) throw new MailboxProviderError("MAIL_RESPONSE_TOO_LARGE"); chunks.push(item.value);
    }
    let result: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("object required");
      result = decoded as Record<string, unknown>;
    } catch { throw new MailboxProviderError("MAIL_INVALID_RESPONSE"); }
    if (readMicrosoftRefreshFailure) throw verifiedMicrosoftRefreshFailure(result, response);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (!complete) {
      controller.abort();
      if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } }
      else if (response) cancel(response.body);
    }
    reader?.releaseLock();
  }
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
  const from = object(object(raw.from).emailAddress), body = object(raw.body), plain = String(body.contentType).toLowerCase() === "text", bodyContent = typeof body.content === "string" ? body.content : null, preview = mailboxText(raw.bodyPreview, 1000), cleanedBody = mailboxText(bodyContent, 65536);
  // Only use this check to select a fallback; never rewrite visible message text.
  const hasVisibleText = (value: string) => /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value);
  const completeText = plain && bodyContent !== null && !(!hasVisibleText(cleanedBody) && hasVisibleText(preview)), content = completeText ? cleanedBody : preview;
  return { providerId: mailboxProviderId(raw.id), threadId: typeof raw.conversationId === "string" ? mailboxProviderId(raw.conversationId) : null, internetMessageId: mailboxText(raw.internetMessageId, 2000) || null, subject: mailboxText(raw.subject, 1000), fromLabel: mailboxText(from.name || from.address, 1000), fromAddress: mailboxAddress(from.address), toAddresses: (Array.isArray(raw.toRecipients) ? raw.toRecipients.slice(0, 50) : []).map((item) => mailboxAddress(object(object(item).emailAddress).address)).filter((value): value is string => value !== null), receivedAt: received(raw.receivedDateTime), bodyText: content, bodyTruncated: !completeText || (bodyContent?.length ?? 0) > 65536, attachments: attachmentRows.slice(0, 50).map((row) => { const item = object(row); return metadataAttachment(item, item.id, item.name, item.contentType, item.size); }), senderIdentityVerified: false };
}

export async function fetchMicrosoftInboxContent(input: { accessToken: string; inboxId: unknown; messageId: string; immutableIds?: boolean; importStart?: number | null; expectedSender?: string | null }, transport: MailboxTransport = defaultTransport) {
  let inboxId: string;
  try {
    inboxId = mailboxProviderId(input.inboxId);
    if (inboxId === "." || inboxId === "..") throw new Error();
  } catch { throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID"); }
  const messageId = mailboxProviderId(input.messageId);
  if (messageId === "." || messageId === "..") throw new MailboxProviderError("MAIL_INVALID_MESSAGE");
  const auth = { ...headers(input.accessToken), ...(input.immutableIds ? { Prefer: 'IdType="ImmutableId"' } : {}) };
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`;
  const detail = await json(`${url}?$select=id,parentFolderId,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,hasAttachments`, { headers: { ...auth, Prefer: `${input.immutableIds ? 'IdType="ImmutableId", ' : ''}outlook.body-content-type="text"` } }, transport);
  try { if (mailboxProviderId(detail.id) !== messageId) throw new Error(); } catch { throw new MailboxProviderError("MAIL_MESSAGE_ID_CHANGED"); }
  let folderId: string;
  try { folderId = mailboxProviderId(detail.parentFolderId); } catch { throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID"); }
  if (folderId !== inboxId) throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID");
  if (input.importStart != null && Date.parse(received(detail.receivedDateTime)) < input.importStart) throw new MailboxProviderError("MAIL_MICROSOFT_DETAIL_CHANGED");
  if (input.expectedSender !== undefined && (!input.expectedSender || mailboxAddress(object(object(detail.from).emailAddress).address) !== input.expectedSender)) throw new MailboxProviderError("MAIL_MICROSOFT_DETAIL_CHANGED");
  const attachments = detail.hasAttachments === true ? await json(`${url}/attachments?$select=id,name,contentType,size,isInline&$top=50`, { headers: auth }, transport) : null;
  if (attachments?.["@odata.nextLink"]) throw new MailboxProviderError("MAIL_TOO_MANY_ATTACHMENTS");
  return parseMicrosoftMailboxMessage(detail, attachments ? array(attachments.value, 50) : []);
}
export async function fetchMailboxPage(input: { provider: MailboxProvider; accessToken: string; grantedScopes: string[]; cursor: string | null; immutableIds?: boolean; importStart?: number | null }, transport: MailboxTransport = defaultTransport) {
  if (!hasMailboxReadScope(input.provider, input.grantedScopes)) throw new MailboxProviderError("MAIL_SCOPE_REQUIRED");
  const auth = { ...headers(input.accessToken), ...(input.immutableIds ? { Prefer: 'IdType="ImmutableId"' } : {}) };
  if (input.provider === "google") {
    const cursor = mailboxCursor("google", input.cursor);
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"); url.searchParams.set("maxResults", "5"); url.searchParams.set("labelIds", "INBOX"); if (cursor) url.searchParams.set("pageToken", cursor);
    const list = await json(url.toString(), { headers: auth }, transport), rows = list.messages === undefined ? [] : array(list.messages, 5);
    // Finish one request at a time so an invalid response cannot release the
    // caller's lease while another request from this page is still in flight.
    const messages: MailboxImportedMessage[] = [];
    for (const row of rows) {
      const listedId = mailboxProviderId(object(row).id);
      const detail = await json(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(listedId)}?format=full`, { headers: auth }, transport);
      assertGmailInboxDetail(detail, listedId);
      messages.push(parseGoogleMailboxMessage(detail));
    }
    return { messages, nextCursor: mailboxCursor("google", list.nextPageToken), verifiedInboxId: null };
  }
  // A broad or foreign-origin saved cursor must never be requested, even before
  // the independently authenticated Inbox folder ID has been fetched.
  microsoftMailboxCursorCandidate(input.cursor);
  const inbox = await json("https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id", { headers: auth }, transport, 65536);
  let inboxId: string;
  try { inboxId = mailboxProviderId(inbox.id); if (inboxId === "." || inboxId === "..") throw new Error(); } catch { throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID"); }
  const cursor = mailboxCursor("microsoft", input.cursor, inboxId);
  const url = cursor ? new URL(cursor) : new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  if (!cursor) {
    url.searchParams.set("$top", "5");
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$select", input.importStart == null ? "id" : "id,receivedDateTime");
    if (input.importStart != null) url.searchParams.set("$filter", `receivedDateTime ge ${new Date(input.importStart).toISOString()}`);
  }
  const requestedUrl = cursor ?? url.toString();
  const list = await json(requestedUrl, { headers: auth }, transport), rows = array(list.value, 5);
  // Validate a returned continuation before reading any listed message.
  const hasNext = Object.hasOwn(list, "@odata.nextLink");
  const nextCursor = hasNext ? mailboxCursor("microsoft", list["@odata.nextLink"], inboxId) : null;
  if (hasNext && nextCursor === null) throw new MailboxProviderError("MAIL_INVALID_RESPONSE");
  if (nextCursor === requestedUrl) throw new MailboxProviderError("MAIL_CURSOR_STALLED");
  // Bound work to one in-flight detail chain. On any failure the caller must
  // not release its lease while another chain can still request attachments.
  const messages: MailboxImportedMessage[] = [];
  for (const row of rows) {
    const item = object(row);
    if (input.importStart != null && Date.parse(received(item.receivedDateTime)) < input.importStart) continue;
    const listedId = mailboxProviderId(item.id);
    messages.push(await fetchMicrosoftInboxContent({ accessToken: input.accessToken, inboxId, messageId: listedId, immutableIds: input.immutableIds, importStart: input.importStart }, transport));
  }
  return { messages, nextCursor, verifiedInboxId: inboxId };
}
function tenant() { const value = process.env.MICROSOFT_TENANT_ID?.trim() || "common"; if (!/^[A-Za-z0-9-]+$/.test(value)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG"); return value; }
const productionCrmProjectId = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
const productionMailboxClientId = "0c00e270-a9c7-473e-baa2-3400058e8375";

function verifiedProductionMailboxTarget(env: NodeJS.ProcessEnv) {
  const releaseSha = env.MICROSOFT_MAILBOX_PRODUCTION_RELEASE_SHA;
  // The shared reader accesses the Next build constant directly. Reading it
  // off the dynamic runtime env object would skip build-time substitution.
  const buildSha = getBuildMetadata().gitSha;
  return env.VERCEL_ENV === "production" &&
    env.VERCEL_TARGET_ENV === "production" &&
    env.VERCEL_PROJECT_ID === productionCrmProjectId &&
    env.NOVALURE_APP_ORIGIN === publicSiteOrigin &&
    env.MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD === "vercel-oidc" &&
    env.MICROSOFT_MAILBOX_CLIENT_ID?.trim().toLowerCase() === productionMailboxClientId &&
    env.MICROSOFT_MAILBOX_CLIENT_SECRET === undefined &&
    env.VERCEL_OIDC_TOKEN === undefined && env.VERCEL_OIDC_TOKEN_FILE === undefined &&
    typeof releaseSha === "string" && /^[0-9a-f]{40}$/.test(releaseSha) &&
    releaseSha === buildSha &&
    (env.VERCEL_GIT_COMMIT_SHA === undefined || env.VERCEL_GIT_COMMIT_SHA === buildSha);
}

/** A dedicated identity requires an explicit mode matched to its release target. */
export function verifiedExternalMailboxMode(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.MICROSOFT_MAILBOX_IDENTITY_MODE?.trim();
  const legacy = env.MICROSOFT_MAILBOX_ALLOW_LEGACY;
  if (legacy !== undefined && legacy !== "0" && legacy !== "1") throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  // Legacy is a deployment-wide, explicit compatibility exception. Never
  // allow it alongside a dedicated client or a verified identity mode.
  if (!mode) {
    if (legacy !== "1" || hasDedicatedMicrosoftMailboxClient(env)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
    return false;
  }
  if (legacy === "1" || env.VERCEL !== "1" || !hasDedicatedMicrosoftMailboxClient(env) || !microsoftClientAuthConfigured(microsoftMailboxClientEnv(env))) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  const allowedTarget = mode === "verified-preview"
    ? env.VERCEL_ENV === "preview"
    : mode === "verified-production" && verifiedProductionMailboxTarget(env);
  if (!allowedTarget) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  // Separate variable names do not establish separate Microsoft apps.
  const calendarClient = env.MICROSOFT_CLIENT_ID?.trim().toLowerCase();
  if (calendarClient && calendarClient === microsoftMailboxClientId(env).toLowerCase()) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  return true;
}
function verifiedAuthority(value: string) { if (value !== "common" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG"); return value; }
export function mailboxOAuthConfigured(provider: MailboxProvider) {
  if (provider === "microsoft") { try { verifiedExternalMailboxMode(); } catch { return false; } }
  return Boolean(Buffer.byteLength(process.env.OAUTH_STATE_SECRET?.trim() || "", "utf8") >= 32 && process.env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim() && (provider === "google" ? process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim() : microsoftClientAuthConfigured(microsoftMailboxClientEnv())));
}
export function mailboxOrigin(requestUrl: string) { if (!["http:", "https:"].includes(new URL(requestUrl).protocol)) throw new MailboxProviderError("MAIL_OAUTH_ORIGIN"); const url = new URL(getTrustedAppOrigin()); if (url.username || url.password || (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new MailboxProviderError("MAIL_OAUTH_ORIGIN"); return url.origin; }
export function mailboxRedirect(provider: MailboxProvider, requestUrl: string) { return `${mailboxOrigin(requestUrl)}/api/crm/mailbox/oauth/${provider}/callback`; }
// The configured callback must match the origin actually used for this
// personal flow. This is a mismatch guard, not proof of deployment identity.
function assertVerifiedMailboxOrigin(requestUrl: string) {
  const requested = new URL(requestUrl);
  if (requested.protocol !== "https:" || requested.username || requested.password || requested.origin !== mailboxOrigin(requestUrl)) throw new MailboxProviderError("MAIL_OAUTH_ORIGIN");
}
export function mailboxAuthorizationUrl(input: { provider: MailboxProvider; requestUrl: string; state: string; codeChallenge: string; verifiedExternalNonce?: string }) {
  if (!mailboxOAuthConfigured(input.provider)) throw new MailboxProviderError("MAIL_OAUTH_NOT_CONFIGURED");
  if (input.provider === "microsoft") {
    if (verifiedExternalMailboxMode() !== Boolean(input.verifiedExternalNonce) || input.verifiedExternalNonce && !/^[A-Za-z0-9_-]{32,128}$/.test(input.verifiedExternalNonce)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
    if (input.verifiedExternalNonce) assertVerifiedMailboxOrigin(input.requestUrl);
  } else if (input.verifiedExternalNonce) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  const url = new URL(input.provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : `https://login.microsoftonline.com/${input.verifiedExternalNonce ? "common" : tenant()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", input.provider === "google" ? process.env.GOOGLE_CLIENT_ID!.trim() : microsoftMailboxClientId()); url.searchParams.set("redirect_uri", mailboxRedirect(input.provider, input.requestUrl)); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", mailboxRequestedScopes[input.provider].join(" ")); url.searchParams.set("state", input.state); url.searchParams.set("code_challenge", input.codeChallenge); url.searchParams.set("code_challenge_method", "S256");
  if (input.verifiedExternalNonce) url.searchParams.set("nonce", input.verifiedExternalNonce);
  if (input.provider === "google") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); } else url.searchParams.set("response_mode", "query"); return url.toString();
}
export async function exchangeMailboxToken(input: { provider: MailboxProvider; code?: string; codeVerifier?: string; requestUrl?: string; refreshToken?: string; priorScopes?: string[]; verifiedMicrosoftAuthority?: string }, transport: MailboxTransport = defaultTransport, microsoftAuth = microsoftMailboxClientAuthFields) {
  const provider = input.provider;
  // Validate the identity path before acquiring a client assertion or calling
  // the provider: a verified mailbox exchange must always bind its authority.
  if (provider === "microsoft") {
    if (verifiedExternalMailboxMode() !== Boolean(input.verifiedMicrosoftAuthority)) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
    if (input.verifiedMicrosoftAuthority) verifiedAuthority(input.verifiedMicrosoftAuthority);
    if (input.refreshToken && input.verifiedMicrosoftAuthority === "common") throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
    if (input.verifiedMicrosoftAuthority && !input.refreshToken) {
      if (!input.requestUrl) throw new MailboxProviderError("MAIL_OAUTH_STATE");
      assertVerifiedMailboxOrigin(input.requestUrl);
    }
  } else if (input.verifiedMicrosoftAuthority) throw new MailboxProviderError("MAIL_OAUTH_CONFIG");
  let credentials: Record<string,string>;
  try { credentials = provider === "google" ? { client_id: process.env.GOOGLE_CLIENT_ID?.trim() || "", client_secret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "" } : await microsoftAuth(); }
  catch (error) { throw new MailboxProviderError(error instanceof MicrosoftClientAuthError && error.kind === "unavailable" ? "MAIL_PROVIDER_UNAVAILABLE" : "MAIL_OAUTH_NOT_CONFIGURED"); }
  const body = new URLSearchParams({ ...credentials, grant_type: input.refreshToken ? "refresh_token" : "authorization_code" });
  if (!body.get("client_id") || provider === "google" && !body.get("client_secret")) throw new MailboxProviderError("MAIL_OAUTH_NOT_CONFIGURED");
  if (input.refreshToken) body.set("refresh_token", input.refreshToken); else { if (!input.code || !input.codeVerifier || !input.requestUrl) throw new MailboxProviderError("MAIL_OAUTH_STATE"); body.set("code", input.code); body.set("code_verifier", input.codeVerifier); body.set("redirect_uri", mailboxRedirect(provider, input.requestUrl)); }
  if (provider === "microsoft") body.set("scope", mailboxRequestedScopes.microsoft.join(" "));
  const authority = provider === "microsoft" ? (input.verifiedMicrosoftAuthority ? verifiedAuthority(input.verifiedMicrosoftAuthority) : tenant()) : "";
  const verifiedMicrosoftRefresh = provider === "microsoft" && Boolean(input.refreshToken && input.verifiedMicrosoftAuthority);
  const result = await json(provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, transport, 65536, verifiedMicrosoftRefresh);
  const scopes = typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : input.refreshToken ? input.priorScopes ?? [] : [];
  if (!hasMailboxReadScope(provider, scopes) || provider === "microsoft" && input.verifiedMicrosoftAuthority && !hasVerifiedMicrosoftMailboxScopes(scopes) || typeof result.access_token !== "string" || !result.access_token || !Number.isSafeInteger(result.expires_in) || Number(result.expires_in) < 30 || Number(result.expires_in) > 86400 || result.token_type && String(result.token_type).toLowerCase() !== "bearer") throw new MailboxProviderError("MAIL_SCOPE_REQUIRED");
  const refreshToken = typeof result.refresh_token === "string" ? result.refresh_token : input.refreshToken ?? null;
  if (provider === "microsoft" && input.verifiedMicrosoftAuthority && !input.refreshToken &&
      (!refreshToken || /[\s\u0000-\u001f\u007f]/u.test(refreshToken))) {
    throw new MailboxProviderError("MAIL_REFRESH_GRANT_REQUIRED");
  }
  return { accessToken: result.access_token, refreshToken, idToken: typeof result.id_token === "string" ? result.id_token : null, scopes, expiresAt: new Date(Date.now() + Number(result.expires_in) * 1000).toISOString() };
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
