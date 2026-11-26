import "server-only";
import { mailboxAddress, mailboxCursor, mailboxProviderId, mailboxText, type MailboxImportedMessage, type MailboxProvider } from "../crm-mailbox";
import { assertMicrosoftMailboxCheckpoint, MailboxCheckpointReviewRequired, mailboxDeltaContinuationUrl, mailboxDeltaUrl, mailboxSyncPosition, type MailboxMetadata, type MailboxSyncCheckpoint, type MailboxSyncChange } from "../crm-mailbox-sync";
import { assertGmailInboxDetail, gmailMessageLabels, mailboxProviderJson, MailboxProviderError, parseGoogleMailboxMessage, parseMicrosoftMailboxMessage, type MailboxTransport } from "./mailbox-provider";
const defaultTransport: MailboxTransport = (url, init) => fetch(url, init);
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function rows(v: unknown, max = 5000) { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max) throw new MailboxProviderError("MAIL_INVALID_RESPONSE"); return v.map(obj); }
const auth = (token: string, microsoft = false) => ({ Authorization: `Bearer ${token}`, Accept: "application/json", ...(microsoft ? { Prefer: 'IdType="ImmutableId", odata.maxpagesize=5' } : {}) });
const historyId = (v: unknown) => { if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) throw new MailboxProviderError("MAIL_INVALID_HISTORY_ID"); return v; };
const metadataSelect = "id,conversationId,internetMessageId,internetMessageHeaders,subject,from,toRecipients,ccRecipients,receivedDateTime,parentFolderId";
export async function fetchMailboxSyncPage(provider: MailboxProvider, token: string, checkpoint: MailboxSyncCheckpoint, transport = defaultTransport, inboxId?: string) {
  const after = mailboxSyncPosition(checkpoint), changes: MailboxSyncChange[] = [];
  if (provider === "google") {
    if (!after.anchor && !after.historyCheckpoint) { const profile = await mailboxProviderJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth(token) }, transport, 65536); after.anchor = historyId(profile.historyId); }
    if (after.phase === "bootstrap") {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"); url.searchParams.set("maxResults", "5"); url.searchParams.set("labelIds", "INBOX"); if (after.bootstrapCursor) url.searchParams.set("pageToken", mailboxCursor("google", after.bootstrapCursor)!);
      const page = await mailboxProviderJson(url.toString(), { headers: auth(token) }, transport);
      for (const row of rows(page.messages, 5)) changes.push({ id: mailboxProviderId(row.id) });
      after.bootstrapCursor = mailboxCursor("google", page.nextPageToken); if (!after.bootstrapCursor) after.phase = "history";
    } else {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history"); url.searchParams.set("maxResults", "5"); url.searchParams.set("startHistoryId", historyId(after.historyCheckpoint || after.anchor)); if (after.pendingCursor) url.searchParams.set("pageToken", mailboxCursor("google", after.pendingCursor)!);
      const page = await mailboxProviderJson(url.toString(), { headers: auth(token) }, transport);
      const ids = new Set<string>(); for (const record of rows(page.history, 5)) { for (const field of ["messages", "messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) for (const value of rows(record[field])) { const message = field === "messages" ? value : obj(value.message); ids.add(mailboxProviderId(message.id)); } }
      for (const id of ids) changes.push({ id });
      after.pendingCursor = mailboxCursor("google", page.nextPageToken); after.phase = after.pendingCursor ? "history" : "ready"; if (!after.pendingCursor) after.historyCheckpoint = historyId(page.historyId);
    }
  } else {
    assertMicrosoftMailboxCheckpoint(checkpoint, inboxId);
    if (checkpoint.queued.length) throw new MailboxCheckpointReviewRequired();
    const cursor = after.pendingCursor ?? after.deltaCheckpoint;
    const url = cursor == null ? mailboxDeltaUrl(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=${metadataSelect}&$top=5`, inboxId) : mailboxDeltaContinuationUrl(cursor, inboxId, after.pendingCursor != null ? "next" : "delta");
    const page = await mailboxProviderJson(url, { headers: auth(token, true) }, transport);
    // A partial or ambiguous response must not advance the durable checkpoint.
    // Graph returns a value array and exactly one opaque continuation link.
    const hasNext = Object.hasOwn(page, "@odata.nextLink"), hasDelta = Object.hasOwn(page, "@odata.deltaLink");
    if (!Array.isArray(page.value) || hasNext === hasDelta) throw new MailboxProviderError("MAIL_INVALID_RESPONSE");
    const continuation = mailboxDeltaContinuationUrl(page[hasNext ? "@odata.nextLink" : "@odata.deltaLink"], inboxId, hasNext ? "next" : "delta");
    for (const row of rows(page.value, 500)) changes.push({ id: mailboxProviderId(row.id), ...(row["@removed"] ? { removed: true } : {}) });
    after.pendingCursor = hasNext ? continuation : null;
    if (after.pendingCursor) after.phase = after.deltaCheckpoint ? "history" : "bootstrap";
    else { after.deltaCheckpoint = continuation; after.phase = "ready"; }
  }
  return { changes, after };
}
export async function fetchMailboxInboxId(token: string, transport = defaultTransport) { const folder = await mailboxProviderJson('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id', { headers: auth(token, true) }, transport, 65536); return mailboxProviderId(folder.id); }
export async function fetchMailboxMetadata(provider: MailboxProvider, token: string, id: string, transport = defaultTransport, inboxId?: string): Promise<MailboxMetadata | null> {
  const messageId = encodeURIComponent(mailboxProviderId(id));
  let microsoftInboxId: string | null = null;
  if (provider === "microsoft") {
    try { microsoftInboxId = mailboxProviderId(inboxId); }
    catch { throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID"); }
  }
  let raw: Record<string, unknown>;
  try { raw = await mailboxProviderJson(provider === "google" ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References&fields=id,threadId,labelIds,internalDate,payload(headers)` : `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=${metadataSelect}`, { headers: auth(token, provider === "microsoft") }, transport); }
  catch (error) { if (error instanceof MailboxProviderError && error.status === 404) return null; if (provider === "google" && !(error instanceof MailboxProviderError)) throw new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE"); throw error; }
  // Check Gmail labels before any other field can produce a quarantined error.
  const googleLabels = provider === "google" ? gmailMessageLabels(raw.labelIds) : null;
  if (mailboxProviderId(raw.id) !== id) throw new MailboxProviderError("MAIL_MESSAGE_ID_CHANGED");
  // A missing or malformed parent folder is not evidence that the message
  // left the Inbox. Let the caller quarantine/retry instead of persisting a
  // false folder-change status. Opaque Microsoft IDs remain case-sensitive.
  let microsoftInInbox = false;
  if (provider === "microsoft") {
    try { microsoftInInbox = mailboxProviderId(raw.parentFolderId) === microsoftInboxId; }
    catch { throw new MailboxProviderError("MAIL_INVALID_FOLDER_ID"); }
  }
  const headerRows = rows(provider === "google" ? obj(raw.payload).headers : raw.internetMessageHeaders, 200), header = (name: string) => mailboxText(headerRows.find(row => String(row.name).toLowerCase() === name)?.value, 4000);
  const addresses = (value: string) => value.split(",").slice(0, 50).map(mailboxAddress).filter((v): v is string => Boolean(v));
  const fromAddress = mailboxAddress(provider === "google" ? header("from") : obj(obj(raw.from).emailAddress).address);
  const toAddresses = provider === "google" ? addresses(header("to")) : rows(raw.toRecipients, 50).map(row => mailboxAddress(obj(row.emailAddress).address)).filter((v): v is string => Boolean(v));
  const cc = provider === "google" ? addresses(header("cc")) : rows(raw.ccRecipients, 50).map(row => mailboxAddress(obj(row.emailAddress).address)).filter((v): v is string => Boolean(v));
  const timestamp = provider === "google" ? Number(raw.internalDate) : Date.parse(String(raw.receivedDateTime)); if (!Number.isFinite(timestamp)) throw new MailboxProviderError("MAIL_INVALID_DATE");
  return { providerId: mailboxProviderId(raw.id), threadId: typeof (raw.threadId || raw.conversationId) === "string" ? String(raw.threadId || raw.conversationId) : null, internetMessageId: provider === "google" ? header("message-id") || null : mailboxText(raw.internetMessageId, 2000) || null, inReplyTo: header("in-reply-to") || null, references: (header("references").match(/<[^<>\s]+>/g) || []).slice(0, 50), fromAddress, toAddresses, participants: [...new Set([...(fromAddress ? [fromAddress] : []), ...toAddresses, ...cc])].sort(), subject: mailboxText(provider === "google" ? header("subject") : raw.subject, 1000), receivedAt: new Date(timestamp).toISOString(), inInbox: provider === "google" ? googleLabels!.includes('INBOX') : microsoftInInbox };
}
export async function fetchMailboxKnownContent(provider: MailboxProvider, token: string, id: string, transport = defaultTransport): Promise<MailboxImportedMessage> {
  const encoded = encodeURIComponent(mailboxProviderId(id)), google = provider === "google";
  let raw: Record<string, unknown>;
  try { raw = await mailboxProviderJson(google ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encoded}?format=full` : `https://graph.microsoft.com/v1.0/me/messages/${encoded}?$select=${metadataSelect},body,bodyPreview,hasAttachments`, { headers: { ...auth(token, !google), ...(!google ? { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } : {}) } }, transport); }
  catch (error) { if (google && error instanceof MailboxProviderError && (error.status === 404 || error.status === 410)) throw new MailboxProviderError("MAIL_GMAIL_DETAIL_CHANGED"); if (google && !(error instanceof MailboxProviderError)) throw new MailboxProviderError("MAIL_PROVIDER_UNAVAILABLE"); throw error; }
  if (google) { assertGmailInboxDetail(raw, id); return parseGoogleMailboxMessage(raw); }
  const attachments = raw.hasAttachments === true ? await mailboxProviderJson(`https://graph.microsoft.com/v1.0/me/messages/${encoded}/attachments?$select=id,name,contentType,size,isInline&$top=50`, { headers: auth(token, true) }, transport) : null;
  if (attachments?.["@odata.nextLink"]) throw new MailboxProviderError("MAIL_TOO_MANY_ATTACHMENTS");
  return parseMicrosoftMailboxMessage(raw, attachments ? rows(attachments.value, 50) : []);
}
export async function translateMailboxLegacyIds(token: string, ids: string[], transport = defaultTransport) {
  if (!ids.length || ids.length > 20) throw new MailboxProviderError("MAIL_INVALID_ID_BATCH");
  const response = await mailboxProviderJson("https://graph.microsoft.com/v1.0/me/translateExchangeIds", { method: "POST", headers: { ...auth(token, true), "Content-Type": "application/json" }, body: JSON.stringify({ inputIds: ids, sourceIdType: "restId", targetIdType: "restImmutableEntryId" }) }, transport);
  const translated = rows(response.value, 20).map(row => ({ oldId: mailboxProviderId(row.sourceId), newId: mailboxProviderId(row.targetId) }));
  if (translated.length !== ids.length || new Set(translated.map(row => row.oldId)).size !== ids.length || translated.some(row => !ids.includes(row.oldId))) throw new MailboxProviderError("MAIL_ID_MIGRATION_REVIEW_REQUIRED");
  return translated;
}
